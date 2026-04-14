import test from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.mjs";
import { createES256TestJWT, signTestJWT, TEST_JWT_SECRET, TEST_USER_ID } from "./test-auth.mjs";

function createKvNamespace(initialValue = null) {
  let value = initialValue;
  return {
    async get() {
      return value;
    },
    async put(_key, nextValue) {
      value = nextValue;
    }
  };
}

function createKeyedKvNamespace() {
  const store = {};
  return {
    store,
    async get(key) {
      return store[key] ?? null;
    },
    async put(key, value) {
      store[key] = value;
    }
  };
}

function createMemoryBucket() {
  const objects = new Map();

  return {
    objects,
    async put(key, value, options = {}) {
      let bytes;
      if (typeof value === "string") {
        bytes = new TextEncoder().encode(value);
      } else if (value instanceof Uint8Array) {
        bytes = new Uint8Array(value);
      } else if (value?.getReader) {
        const reader = value.getReader();
        const chunks = [];
        for (;;) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          chunks.push(chunk);
        }
        const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
      } else {
        bytes = new Uint8Array(await new Response(value).arrayBuffer());
      }

      objects.set(key, {
        bytes,
        contentType: options.httpMetadata?.contentType ?? "application/octet-stream"
      });
    },
    async get(key) {
      const entry = objects.get(key);
      if (!entry) return null;
      return {
        async arrayBuffer() {
          return entry.bytes.buffer.slice(
            entry.bytes.byteOffset,
            entry.bytes.byteOffset + entry.bytes.byteLength
          );
        },
        async json() {
          return JSON.parse(new TextDecoder().decode(entry.bytes));
        }
      };
    }
  };
}

const env = {
  APP_NAME: "NewsRoll",
  SUPABASE_JWT_SECRET: TEST_JWT_SECRET,
  PUBLIC_BASE_URL: "https://newsroll.invalid",
  REVENUECAT_SECRET_KEY: "sk_test_fake",
  REVENUECAT_PROJECT_ID: "proj_test_fake"
};

function createColdStartDb(rows) {
  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (sql.includes("FROM user_profiles")) {
                return {
                  endpointScores: "{}",
                  totalImpressions: 0,
                  totalEngagements: 0
                };
              }
              return null;
            },
            async all() {
              if (sql.includes("FROM published_feed_entries")) {
                const cursor = args.length === 2 ? args[0] : null;
                const limit = args.at(-1);
                return {
                  results: rows
                    .filter((row) => cursor == null || row.publishSequence < cursor)
                    .slice(0, limit)
                };
              }
              return { results: [] };
            }
          };
        }
      };
    }
  };
}

function withMockedFetch(mocks, fn) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    const urlPath = url.split("?")[0];

    for (const mock of mocks) {
      if (mock.matchEnd ? urlPath.endsWith(mock.matchEnd) : urlPath.includes(mock.match)) {
        const body = typeof mock.body === "function" ? await mock.body({ input, init, url, urlPath }) : mock.body;
        const status = typeof mock.status === "function" ? await mock.status({ input, init, url, urlPath }) : (mock.status ?? 200);
        return new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" }
        });
      }
    }

    return originalFetch(input, init);
  };

  return fn().finally(() => {
    globalThis.fetch = originalFetch;
  });
}

test("health endpoint responds", async () => {
  const response = await worker.fetch(new Request("https://example.com/health"), env);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, true);
});

test("admin test prompt can resolve crawl content without generating an image", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;

  globalThis.setTimeout = (fn, _ms, ...args) => {
    fn(...args);
    return 0;
  };

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);

    if (url.endsWith("/browser-rendering/crawl")) {
      return Response.json({
        success: true,
        result: "job-admin-crawl-1"
      });
    }

    if (url.includes("/browser-rendering/crawl/job-admin-crawl-1?limit=1")) {
      return Response.json({
        success: true,
        result: {
          id: "job-admin-crawl-1",
          status: "completed",
          records: [
            {
              url: "https://example.com/article",
              status: "completed",
              markdown: "# Crawled story\n\nBody from crawl",
              json: {
                title: "Crawled admin title",
                headline: "Crawled admin headline.",
                language: "en",
                summary: "Crawled admin summary.",
                topics: ["ai", "agents"]
              },
              metadata: { status: 200 }
            }
          ]
        }
      });
    }

    throw new Error(`Unexpected fetch call: ${url} ${init.method ?? "GET"}`);
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  });

  const response = await worker.fetch(new Request("https://example.com/admin/test-prompt", {
    method: "POST",
    headers: {
      authorization: "Bearer admin-secret",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      url: "https://example.com/article",
      generateImage: false
    })
  }), {
    ...env,
    ADMIN_API_KEY: "admin-secret",
    CLOUDFLARE_ACCOUNT_ID: "account-123",
    CLOUDFLARE_API_TOKEN: "token-123"
  });

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.status, "resolved");
  assert.equal(payload.imageUrl, null);
  assert.equal(payload.resolvedContent.title, "Crawled admin title");
  assert.equal(payload.resolvedContent.sourceKind, "crawl");
  assert.equal(payload.resolvedContent.textPreview.includes("Body from crawl"), true);
  assert.deepEqual(payload.resolvedContent.metadata, {
    title: "Crawled admin title",
    headline: "Crawled admin headline.",
    language: "en",
    summary: "Crawled admin summary.",
    topics: ["ai", "agents"]
  });
  assert.equal(payload.approval, null);
});

test("admin test prompt can save a preview and apply it to overwrite an existing item", async (t) => {
  const originalFetch = globalThis.fetch;
  const bucket = createMemoryBucket();
  const writes = {
    storyMedia: [],
    storyContent: [],
    promptRunEvents: []
  };
  const publishedEntry = {
    story_id: 12345,
    publish_sequence: 88,
    source_endpoint: "tech",
    published_at: "2026-04-08T10:00:00.000Z",
    media_url: "https://media.example.com/old.webp",
    media_status: "ready",
    headline: "Old headline"
  };

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";

    if (url.startsWith("https://fal.run/")) {
      return new Response(JSON.stringify({
        images: [{ url: "https://assets.example.com/generated.webp" }],
        request_id: "req-admin-1"
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-fal-billable-units": "1"
        }
      });
    }

    if (url === "https://assets.example.com/generated.webp") {
      return new Response(Uint8Array.from([1, 2, 3, 4]), {
        status: 200,
        headers: { "content-type": "image/webp" }
      });
    }

    if (url.includes("/rest/v1/story_content")) {
      if (method === "GET") {
        return Response.json([]);
      }
      if (method === "POST") {
        writes.storyContent.push(JSON.parse(init.body));
        return Response.json([]);
      }
    }

    if (url.includes("/rest/v1/published_feed_entries")) {
      if (method === "GET") {
        return Response.json([publishedEntry]);
      }
      if (method === "PATCH") {
        Object.assign(publishedEntry, JSON.parse(init.body));
        return Response.json([publishedEntry]);
      }
    }

    if (url.includes("/rest/v1/story_media") && method === "POST") {
      writes.storyMedia.push(JSON.parse(init.body));
      return Response.json([]);
    }

    if (url.includes("/rest/v1/prompt_run_events") && method === "POST") {
      writes.promptRunEvents.push(JSON.parse(init.body));
      return Response.json([{ id: "prompt-run-1" }]);
    }

    throw new Error(`Unexpected fetch call: ${url} ${method}`);
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const baseEnv = {
    ...env,
    ADMIN_API_KEY: "admin-secret",
    FAL_API_KEY: "fal-test-key",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SECRET_KEY: "service-role-test",
    PUBLIC_MEDIA_BASE_URL: "https://media.example.com",
    MEDIA_BUCKET: bucket,
    VISUAL_FEED_CACHE: createKvNamespace(JSON.stringify({
      version: 1,
      items: [
        {
          storyId: 12345,
          publishSequence: 88,
          sourceEndpoint: "tech",
          publishedAt: "2026-04-08T10:00:00.000Z",
          mediaUrl: "https://media.example.com/old.webp",
          readableUrl: "https://newsroll.invalid/v1/stories/12345/article",
          mediaStatus: "ready",
          headline: "Old headline"
        }
      ]
    }))
  };

  const previewResponse = await worker.fetch(new Request("https://example.com/admin/test-prompt", {
    method: "POST",
    headers: {
      authorization: "Bearer admin-secret",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      storyId: 12345,
      title: "Story title",
      text: "Manual article body for admin test",
      provider: "fal",
      logPromptRun: false
    })
  }), baseEnv);

  assert.equal(previewResponse.status, 200);
  const previewPayload = await previewResponse.json();
  assert.equal(previewPayload.status, "ready");
  assert.equal(previewPayload.approval.canApply, true);
  assert.equal(previewPayload.resolvedContent.sourceKind, "provided");
  assert.equal(previewPayload.r2Url, previewPayload.approval.testAssetUrl);

  const applyResponse = await worker.fetch(new Request("https://example.com/admin/test-prompt", {
    method: "POST",
    headers: {
      authorization: "Bearer admin-secret",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      applyApprovedTest: true,
      testManifestKey: previewPayload.approval.testManifestKey
    })
  }), baseEnv);

  assert.equal(applyResponse.status, 200);
  const applyPayload = await applyResponse.json();
  assert.equal(applyPayload.applied, true);
  assert.equal(applyPayload.storyId, 12345);
  assert.match(applyPayload.mediaKey, /^stories\/12345-[a-f0-9]+\.webp$/);
  assert.equal(applyPayload.mediaUrl, publishedEntry.media_url);
  assert.equal(publishedEntry.media_status, "ready");
  assert.equal(writes.storyMedia.length, 1);
  assert.equal(writes.storyMedia[0].story_id, 12345);
  assert.equal(writes.storyContent.length > 0, true);
  assert.equal(bucket.objects.has(previewPayload.approval.testManifestKey), true);
  assert.equal(
    JSON.parse(await baseEnv.VISUAL_FEED_CACHE.get()).items[0].mediaUrl,
    applyPayload.mediaUrl
  );
});

test("config treats false-like FOR_YOU_FEED_ENABLED values as disabled", async () => {
  const response = await worker.fetch(
    new Request("https://example.com/v1/config"),
    {
      ...env,
      FOR_YOU_FEED_ENABLED: "false"
    }
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(Array.isArray(payload.ai.features), true);
  assert.deepEqual(payload.ai.features.find((feature) => feature.key === "translation"), {
    key: "translation",
    title: "Translate",
    description: "Translate the article and HN comments into a target language.",
    routePath: "/v1/ai/translate",
    promptKey: "translation",
    enabled: true,
    requiresPro: true,
    creditCost: 1,
    usesStory: true,
    usesArticleText: true,
    usesComments: true,
    usesTargetLanguage: true,
    cacheTtlSeconds: 259200
  });
});

test("visual feed returns global fixture data without D1", async () => {
  const response = await worker.fetch(
    new Request("https://example.com/v1/visual-feed"),
    env
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.items.length > 0, true);
  assert.equal(payload.items[0].sourceEndpoint, "front");
  assert.equal(payload.items[0].mediaStatus, "ready");
  assert.equal(payload.items[0].sourceUrl, "https://example.com/articles/43987539");
  assert.equal(payload.items[0].readableUrl, "https://newsroll.invalid/v1/stories/43987539/article");
});

test("visual feed cursor paginates the global fixture feed", async () => {
  const firstPage = await worker.fetch(
    new Request("https://example.com/v1/visual-feed?limit=1"),
    env
  );

  assert.equal(firstPage.status, 200);
  const firstPayload = await firstPage.json();
  assert.equal(firstPayload.items.length, 1);
  assert.equal(firstPayload.items[0].publishSequence, 2);
  assert.equal(firstPayload.nextCursor, 2);

  const secondPage = await worker.fetch(
    new Request(`https://example.com/v1/visual-feed?cursor=${firstPayload.nextCursor}&limit=1`),
    env
  );

  assert.equal(secondPage.status, 200);
  const secondPayload = await secondPage.json();
  assert.equal(secondPayload.items.length, 1);
  assert.equal(secondPayload.items[0].publishSequence, 1);
  assert.equal(secondPayload.nextCursor, 1);
});

test("visual feed uses cached snapshot for the first page when available", async () => {
  const response = await worker.fetch(
    new Request("https://example.com/v1/visual-feed?limit=1"),
    {
      ...env,
      VISUAL_FEED_CACHE: createKvNamespace(JSON.stringify({
        version: 1,
        items: [
          {
            storyId: 50000001,
            publishSequence: 99,
            sourceEndpoint: "show",
            publishedAt: "2026-03-12T10:15:00.000Z",
            mediaUrl: "https://cdn.example.com/story.jpg",
            sourceUrl: "https://example.com/articles/50000001",
            readableUrl: "https://newsroll.invalid/v1/stories/50000001/article",
            mediaStatus: "ready",
            headline: "Cached snapshot headline"
          }
        ]
      }))
    }
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.items[0].storyId, 50000001);
  assert.equal(payload.items[0].sourceEndpoint, "show");
  assert.equal(payload.items[0].headline, "Cached snapshot headline");
});

test("visual feed ignores stale cached snapshot rows that predate headline support", async () => {
  const response = await worker.fetch(
    new Request("https://example.com/v1/visual-feed?limit=1"),
    {
      ...env,
      VISUAL_FEED_CACHE: createKvNamespace(JSON.stringify({
        version: 1,
        items: [
          {
            storyId: 50000001,
            publishSequence: 99,
            sourceEndpoint: "show",
            publishedAt: "2026-03-12T10:15:00.000Z",
            mediaUrl: "https://cdn.example.com/story.jpg",
            readableUrl: "https://newsroll.invalid/v1/stories/50000001/article",
            mediaStatus: "ready"
          }
        ]
      }))
    }
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  // Stale cache (no headline) is ignored; falls back to fixture feed
  assert.equal(payload.items[0].storyId, 43987539);
});

test("protected routes accept ES256 Supabase JWTs via JWKS", async () => {
  const supabaseUrl = "https://snazihvdznshybaogwrx.supabase.co";
  const { token, jwks } = createES256TestJWT(TEST_USER_ID, { supabaseUrl });

  const response = await withMockedFetch([
    {
      matchEnd: "/auth/v1/.well-known/jwks.json",
      body: jwks
    }
  ], async () => worker.fetch(
    new Request("https://example.com/v1/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        events: [
          {
            storyId: 123,
            eventType: "impression",
            surface: "test"
          }
        ]
      })
    }),
    {
      ...env,
      SUPABASE_URL: supabaseUrl
    }
  ));

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, true);
});

test("endpoint-scoped visual feed routes are removed", async () => {
  const response = await worker.fetch(
    new Request("https://example.com/v1/visual-feed/front"),
    env
  );

  assert.equal(response.status, 404);
});

test("worker does not proxy public story reads for the app", async () => {
  const response = await worker.fetch(
    new Request("https://example.com/v1/stories/123"),
    env
  );

  assert.equal(response.status, 404);
});

// ── Async Crawl Endpoints ─────────────────────────────────────────────

test("POST /admin/media/crawl returns running task immediately", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;

  // Make setTimeout synchronous so background crawl runs instantly
  globalThis.setTimeout = (fn, _ms, ...args) => { fn(...args); return 0; };
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/browser-rendering/crawl")) {
      return Response.json({ success: true, result: "job-async-crawl-1" });
    }
    if (url.includes("/browser-rendering/crawl/job-async-crawl-1")) {
      return Response.json({
        success: true,
        result: {
          id: "job-async-crawl-1",
          status: "completed",
          records: [{
            url: "https://example.com/async-article",
            status: "completed",
            markdown: "# Async Article\n\nBody text.",
            json: { title: "Async Title", headline: "Headline.", language: "en", summary: "Summary.", topics: ["async"] },
            metadata: { status: 200 }
          }]
        }
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; globalThis.setTimeout = originalSetTimeout; });

  const kv = createKeyedKvNamespace();
  // Capture the background promise via a mock ctx
  let backgroundPromise = null;
  const ctx = {
    waitUntil(p) { backgroundPromise = p; }
  };

  const crawlEnv = {
    ...env,
    ADMIN_API_KEY: "admin-secret",
    CLOUDFLARE_ACCOUNT_ID: "account-123",
    CLOUDFLARE_API_TOKEN: "token-123",
    VISUAL_FEED_CACHE: kv
  };

  // Submit crawl
  const submitRes = await worker.fetch(new Request("https://example.com/admin/media/crawl", {
    method: "POST",
    headers: { authorization: "Bearer admin-secret", "content-type": "application/json" },
    body: JSON.stringify({ url: "https://example.com/async-article" })
  }), crawlEnv, ctx);

  assert.equal(submitRes.status, 200);
  const submitPayload = await submitRes.json();
  assert.equal(submitPayload.status, "running");
  assert.ok(submitPayload.crawlTaskId);

  // Wait for background crawl to finish
  assert.ok(backgroundPromise, "ctx.waitUntil should have been called");
  await backgroundPromise;

  // Poll status
  const statusRes = await worker.fetch(
    new Request(`https://example.com/admin/media/crawl/${submitPayload.crawlTaskId}`, {
      headers: { authorization: "Bearer admin-secret" }
    }),
    crawlEnv
  );

  assert.equal(statusRes.status, 200);
  const statusPayload = await statusRes.json();
  assert.equal(statusPayload.status, "completed");
  assert.equal(statusPayload.crawlProvider, "cloudflare");
  assert.ok(statusPayload.markdown.includes("Async Article"));

  // Use crawlTaskId in /admin/media/prompt
  const promptRes = await worker.fetch(new Request("https://example.com/admin/media/prompt", {
    method: "POST",
    headers: { authorization: "Bearer admin-secret", "content-type": "application/json" },
    body: JSON.stringify({ crawlTaskId: submitPayload.crawlTaskId })
  }), crawlEnv);

  assert.equal(promptRes.status, 200);
  const promptPayload = await promptRes.json();
  assert.equal(promptPayload.resolvedContent.sourceKind, "crawl");
  assert.equal(promptPayload.resolvedContent.crawlProvider, "cloudflare");
  assert.ok(promptPayload.resolvedContent.textPreview.includes("Async Article"));
});

test("GET /admin/media/crawl/:taskId returns 404 for unknown task", async () => {
  const kv = createKeyedKvNamespace();
  const res = await worker.fetch(
    new Request("https://example.com/admin/media/crawl/nonexistent-id", {
      headers: { authorization: "Bearer admin-secret" }
    }),
    { ...env, ADMIN_API_KEY: "admin-secret", VISUAL_FEED_CACHE: kv }
  );
  assert.equal(res.status, 404);
});

test("POST /admin/media/crawl requires url", async () => {
  const res = await worker.fetch(new Request("https://example.com/admin/media/crawl", {
    method: "POST",
    headers: { authorization: "Bearer admin-secret", "content-type": "application/json" },
    body: JSON.stringify({})
  }), { ...env, ADMIN_API_KEY: "admin-secret" });

  assert.equal(res.status, 400);
  const payload = await res.json();
  assert.ok(payload.error.includes("url"));
});

test("resolveAdminTestContent returns 202 when crawl task is still running", async () => {
  const kv = createKeyedKvNamespace();
  // Write a "running" task directly to KV
  kv.store["crawl-task:task-running-1"] = JSON.stringify({ status: "running", url: "https://example.com" });

  const res = await worker.fetch(new Request("https://example.com/admin/media/prompt", {
    method: "POST",
    headers: { authorization: "Bearer admin-secret", "content-type": "application/json" },
    body: JSON.stringify({ crawlTaskId: "task-running-1" })
  }), { ...env, ADMIN_API_KEY: "admin-secret", VISUAL_FEED_CACHE: kv });

  assert.equal(res.status, 202);
  const payload = await res.json();
  assert.ok(payload.details.crawlTaskId);
  assert.equal(payload.details.status, "running");
});

test("resolveAdminTestContent returns 422 when crawl task failed", async () => {
  const kv = createKeyedKvNamespace();
  kv.store["crawl-task:task-failed-1"] = JSON.stringify({
    status: "failed",
    url: "https://example.com",
    error: "Timeout",
    crawlProvider: "cloudflare",
    cfError: "Cloudflare crawl job did not complete within timeout",
    cfFailureKind: "timeout"
  });

  const res = await worker.fetch(new Request("https://example.com/admin/media/prompt", {
    method: "POST",
    headers: { authorization: "Bearer admin-secret", "content-type": "application/json" },
    body: JSON.stringify({ crawlTaskId: "task-failed-1" })
  }), { ...env, ADMIN_API_KEY: "admin-secret", VISUAL_FEED_CACHE: kv });

  assert.equal(res.status, 422);
  const payload = await res.json();
  assert.equal(payload.details.cfFailureKind, "timeout");
  assert.equal(payload.details.crawlProvider, "cloudflare");
});
