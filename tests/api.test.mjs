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
    },
    async delete(key) {
      objects.delete(key);
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

    if (url === "https://api.openai.com/v1/chat/completions") {
      return Response.json({
        choices: [
          {
            message: {
              content: "Optimized editorial image prompt from admin crawl metadata."
            }
          }
        ]
      });
    }

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
    OPENAI_API_KEY: "openai-test-key",
    CLOUDFLARE_ACCOUNT_ID: "account-123",
    CLOUDFLARE_API_TOKEN: "token-123"
  });

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.status, "resolved");
  assert.equal(payload.imageUrl, null);
  assert.equal(payload.resolvedPrompt, "Optimized editorial image prompt from admin crawl metadata.");
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

test("admin media prompt dryRun returns a prompt without saving prompt artifacts", async (t) => {
  const writes = {
    promptGenerations: [],
    promptRunEvents: []
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";

    if (url === "https://api.openai.com/v1/chat/completions") {
      return Response.json({
        choices: [
          {
            message: {
              content: "Dry-run optimized editorial image prompt."
            }
          }
        ]
      });
    }

    if (url.endsWith("/browser-rendering/crawl")) {
      return Response.json({
        success: true,
        result: "job-admin-dry-run-1"
      });
    }

    if (url.includes("/browser-rendering/crawl/job-admin-dry-run-1?limit=1")) {
      return Response.json({
        success: true,
        result: {
          id: "job-admin-dry-run-1",
          status: "completed",
          records: [
            {
              url: "https://example.com/dry-run-article",
              status: "completed",
              markdown: "# Dry Run Story\n\nPrompt-only crawl body",
              json: {
                title: "Dry Run Admin Title",
                headline: "Dry Run Admin Headline",
                language: "en",
                summary: "Dry Run Admin Summary",
                topics: ["testing", "dry-run"]
              },
              metadata: { status: 200 }
            }
          ]
        }
      });
    }

    if (url.includes("/rest/v1/image_prompt_optimizer_configs") && method === "GET") {
      return Response.json([{
        id: 91,
        key: "news_image_prompt_optimizer",
        version: "v1.1-a",
        name: "News Image Prompt Optimizer - Production Generalist",
        optimizer_provider: "openai",
        optimizer_model: "gpt-5.4-mini-2026-03-17",
        generation_provider: "fal",
        generation_model: "fal-ai/flux-2/turbo",
        max_completion_tokens: 500,
        system_prompt: "system",
        user_prompt_template: "template",
        topic_matchers: ["testing"],
        keyword_matchers: [],
        routing_priority: 100,
        fallback: true,
        settings: {},
        active: true
      }]);
    }

    if (url.includes("/rest/v1/image_prompt_generations") && method === "POST") {
      writes.promptGenerations.push(JSON.parse(init.body));
      return Response.json([{ id: 501 }]);
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

  const response = await worker.fetch(new Request("https://example.com/admin/media/prompt", {
    method: "POST",
    headers: {
      authorization: "Bearer admin-secret",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      url: "https://example.com/dry-run-article",
      dryRun: true
    })
  }), {
    ...env,
    ADMIN_API_KEY: "admin-secret",
    OPENAI_API_KEY: "openai-test-key",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SECRET_KEY: "service-role-test",
    CLOUDFLARE_ACCOUNT_ID: "account-123",
    CLOUDFLARE_API_TOKEN: "token-123"
  });

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.status, "resolved");
  assert.equal(payload.dryRun, true);
  assert.equal(payload.resolvedPrompt, "Dry-run optimized editorial image prompt.");
  assert.equal(payload.promptGenerationId, null);
  assert.equal(payload.optimizerPromptRunEventId, null);
  assert.equal(writes.promptGenerations.length, 0);
  assert.equal(writes.promptRunEvents.length, 0);
});

test("admin media prompt uses optimizerConfigId when provided", async (t) => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";

    if (url === "https://api.openai.com/v1/chat/completions") {
      return Response.json({
        choices: [
          {
            message: {
              content: "Prompt from explicit optimizer config."
            }
          }
        ]
      });
    }

    if (url.includes("/rest/v1/story_content") && method === "GET" && url.includes("select=extracted_text%2Cai_headline")) {
      return Response.json({
        extracted_text: "Stored text",
        ai_headline: null
      });
    }

    if (url.includes("/rest/v1/story_content") && method === "GET" && url.includes("select=summary%2Cextracted_text%2Cai_headline%2Ctopics")) {
      return Response.json({
        summary: "Stored summary",
        extracted_text: "Stored text",
        ai_headline: null,
        topics: ["finance"]
      });
    }

    if (url.includes("/rest/v1/story_content") && method === "GET" && url.includes("select=story_id%2Csource_url")) {
      return Response.json([]);
    }

    if (url.includes("/rest/v1/published_feed_entries") && method === "GET") {
      return Response.json([]);
    }

    if (url.includes("/rest/v1/story_media") && method === "GET") {
      return Response.json([]);
    }

    if (url.includes("/rest/v1/image_prompt_optimizer_configs") && method === "GET") {
      return Response.json({
        id: 222,
        key: "campaign_optimizer",
        version: "v3",
        name: "Campaign Optimizer",
        optimizer_provider: "openai",
        optimizer_model: "gpt-5.4-mini-2026-03-17",
        generation_provider: "openai",
        generation_model: "gpt-image-1",
        max_completion_tokens: 500,
        system_prompt: "system",
        user_prompt_template: "template",
        topic_matchers: ["finance"],
        keyword_matchers: ["regulation"],
        routing_priority: 20,
        fallback: false,
        settings: {},
        active: true
      });
    }

    if (url.includes("/rest/v1/image_prompt_generations") && method === "POST") {
      return Response.json([{ id: 501 }]);
    }

    throw new Error(`Unexpected fetch call: ${url} ${method}`);
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const response = await worker.fetch(new Request("https://example.com/admin/media/prompt", {
    method: "POST",
    headers: {
      authorization: "Bearer admin-secret",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      storyId: 12345,
      optimizerConfigId: 222,
      logPromptRun: false
    })
  }), {
    ...env,
    ADMIN_API_KEY: "admin-secret",
    OPENAI_API_KEY: "openai-test-key",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SECRET_KEY: "service-role-test"
  });

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.optimizerUsed.id, 222);
  assert.equal(payload.optimizerUsed.key, "campaign_optimizer");
  assert.equal(payload.optimizerUsed.optimizerProvider, "openai");
  assert.equal(payload.optimizerUsed.generationProvider, "openai");
  assert.equal(payload.resolvedPrompt, "Prompt from explicit optimizer config.");
});

test("admin media generate can apply to an existing story in one request using stored content", async (t) => {
  const originalFetch = globalThis.fetch;
  const bucket = createMemoryBucket();
  const writes = {
    storyMedia: [],
    storyContent: []
  };
  const publishedEntry = {
    story_id: 12345,
    publish_sequence: 88,
    source_endpoint: "tech",
    published_at: "2026-04-08T10:00:00.000Z",
    media_url: "https://media.example.com/stories/12345-old.png",
    media_status: "ready",
    headline: "Existing headline"
  };

  await bucket.put("stories/12345-old.png", Uint8Array.from([9, 9, 9]), {
    httpMetadata: { contentType: "image/png" }
  });

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";

    if (url === "https://api.openai.com/v1/images/generations") {
      return Response.json({
        created: 1710000000,
        data: [{ url: "https://assets.example.com/generated-apply.png" }]
      });
    }

    if (url === "https://assets.example.com/generated-apply.png") {
      return new Response(Uint8Array.from([1, 2, 3, 4]), {
        status: 200,
        headers: { "content-type": "image/png" }
      });
    }

    if (url === "https://api.openai.com/v1/chat/completions") {
      return Response.json({
        choices: [
          {
            message: {
              content: "Optimized editorial prompt from stored content."
            }
          }
        ]
      });
    }

    if (url.includes("/rest/v1/story_content")) {
      if (method === "GET") {
        if (url.includes("select=story_id%2Csource_url")) {
          return Response.json([]);
        }
        if (url.includes("select=summary%2Cextracted_text%2Cai_headline%2Ctopics")) {
          return Response.json({
            summary: "Stored summary from db",
            extracted_text: "Stored crawl text from db",
            ai_headline: null,
            topics: ["technology"]
          });
        }
        return Response.json({
          extracted_text: "Stored crawl text from db",
          ai_headline: null
        });
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

    if (url.includes("/rest/v1/story_media") && method === "GET") {
      return Response.json([{
        story_id: 12345,
        media_url: "https://media.example.com/stories/12345-old.png"
      }]);
    }

    if (url.includes("/rest/v1/image_prompt_optimizer_configs") && method === "GET") {
      return Response.json([{
        id: 91,
        key: "news_image_prompt_optimizer",
        version: "v1.1-a",
        name: "News Image Prompt Optimizer - Production Generalist",
        optimizer_provider: "openai",
        optimizer_model: "gpt-5.4-mini-2026-03-17",
        generation_provider: "openai",
        generation_model: "gpt-image-1",
        max_completion_tokens: 500,
        system_prompt: "system",
        user_prompt_template: "template",
        topic_matchers: ["technology"],
        keyword_matchers: [],
        routing_priority: 100,
        fallback: true,
        settings: {},
        active: true
      }]);
    }

    if (url.includes("/rest/v1/image_prompt_generations") && method === "POST") {
      return Response.json([{ id: 501 }]);
    }

    if (url.includes("/rest/v1/story_media") && method === "POST") {
      writes.storyMedia.push(JSON.parse(init.body));
      return Response.json([]);
    }

    throw new Error(`Unexpected fetch call: ${url} ${method}`);
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const response = await worker.fetch(new Request("https://example.com/admin/media/generate", {
    method: "POST",
    headers: {
      authorization: "Bearer admin-secret",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      storyId: 12345,
      applyToStory: true,
      logPromptRun: false
    })
  }), {
    ...env,
    ADMIN_API_KEY: "admin-secret",
    FAL_API_KEY: "fal-test-key",
    OPENAI_API_KEY: "openai-test-key",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SECRET_KEY: "service-role-test",
    PUBLIC_MEDIA_BASE_URL: "https://media.example.com",
    MEDIA_BUCKET: bucket,
    VISUAL_FEED_CACHE: createKvNamespace()
  });

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.applied, true);
  assert.equal(payload.appliedResult.mediaUrl, writes.storyMedia[0].media_url);
  assert.notEqual(payload.appliedResult.mediaUrl, "https://media.example.com/stories/12345-old.png");
  assert.equal(payload.appliedResult.summary, "Stored summary from db");
  assert.equal(writes.storyMedia.length, 1);
  assert.match(writes.storyMedia[0].media_key, /^stories\/12345-[a-f0-9]+-[a-f0-9-]+\.png$/);
  assert.equal(writes.storyMedia[0].provider, "openai");
  assert.equal(writes.storyMedia[0].model, "gpt-image-1");
  assert.equal(payload.optimizerUsed.generationProvider, "openai");
  assert.equal(bucket.objects.has("stories/12345-old.png"), false);
});

test("admin media generate can recrawl and fully replace stored story content before applying", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const bucket = createMemoryBucket();
  const writes = {
    storyMedia: [],
    storyContent: []
  };
  const publishedEntry = {
    story_id: 12345,
    publish_sequence: 88,
    source_endpoint: "tech",
    published_at: "2026-04-08T10:00:00.000Z",
    media_url: "https://media.example.com/stories/12345-old.webp",
    media_status: "ready",
    headline: "Old headline"
  };

  await bucket.put("old.webp", Uint8Array.from([8, 8, 8]), {
    httpMetadata: { contentType: "image/webp" }
  });

  await bucket.put("stories/12345-old.webp", Uint8Array.from([4, 4, 4]), {
    httpMetadata: { contentType: "image/webp" }
  });

  globalThis.setTimeout = (fn, _ms, ...args) => {
    fn(...args);
    return 0;
  };

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";

    if (url.startsWith("https://fal.run/")) {
      return new Response(JSON.stringify({
        images: [{ url: "https://assets.example.com/generated-recrawl.webp" }],
        request_id: "req-admin-recrawl-1"
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-fal-billable-units": "1"
        }
      });
    }

    if (url === "https://assets.example.com/generated-recrawl.webp") {
      return new Response(Uint8Array.from([5, 6, 7, 8]), {
        status: 200,
        headers: { "content-type": "image/webp" }
      });
    }

    if (url === "https://api.openai.com/v1/chat/completions") {
      return Response.json({
        choices: [
          {
            message: {
              content: "Optimized editorial prompt from recrawl."
            }
          }
        ]
      });
    }

    if (url.endsWith("/browser-rendering/crawl")) {
      return Response.json({
        success: true,
        result: "job-admin-recrawl-1"
      });
    }

    if (url.includes("/browser-rendering/crawl/job-admin-recrawl-1?limit=1")) {
      return Response.json({
        success: true,
        result: {
          id: "job-admin-recrawl-1",
          status: "completed",
          records: [
            {
              url: "https://example.com/recrawl-story",
              status: "completed",
              markdown: "# Recrawled Story\n\nFresh crawl body",
              json: {
                title: "Recrawled title",
                headline: "Recrawled headline",
                language: "en",
                summary: "Recrawled summary",
                topics: ["recrawl", "refresh"]
              },
              metadata: { status: 200 }
            }
          ]
        }
      });
    }

    if (url.includes("/rest/v1/story_content")) {
      if (method === "GET") {
        if (url.includes("select=summary%2Cextracted_text%2Cai_headline%2Ctopics")) {
          return Response.json({
            summary: "Old summary",
            extracted_text: "Old text",
            ai_headline: "Old headline",
            topics: ["technology"]
          });
        }
        return Response.json([{
          story_id: 12345,
          source_url: "https://example.com/old-story"
        }]);
      }
      if (method === "POST") {
        writes.storyContent.push(JSON.parse(init.body));
        return Response.json([]);
      }
    }

    if (url.includes("/rest/v1/rss_items") && method === "GET") {
      return Response.json({
        url: "https://example.com/recrawl-story",
        canonical_url: "https://example.com/recrawl-story",
        rss_sources: {
          feed_url: "https://example.com/feed.xml",
          tier: 1
        }
      });
    }

    if (url.includes("/rest/v1/story_media") && method === "GET") {
      return Response.json([{
        story_id: 12345,
        media_url: "https://media.example.com/stories/12345-old.webp"
      }]);
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

    if (url.includes("/rest/v1/story_media") && method === "GET") {
      return Response.json([{
        story_id: 12345,
        media_url: "https://media.example.com/old.webp"
      }]);
    }

    if (url.includes("/rest/v1/image_prompt_optimizer_configs") && method === "GET") {
      return Response.json([{
        id: 91,
        key: "news_image_prompt_optimizer",
        version: "v1.1-c",
        name: "News Image Prompt Optimizer - Photojournalistic Realism",
        optimizer_provider: "openai",
        optimizer_model: "gpt-5.4-mini-2026-03-17",
        generation_provider: "fal",
        generation_model: "fal-ai/flux-2/turbo",
        max_completion_tokens: 500,
        system_prompt: "system",
        user_prompt_template: "template",
        topic_matchers: ["recrawl", "refresh"],
        keyword_matchers: [],
        routing_priority: 10,
        fallback: false,
        settings: {},
        active: true
      }]);
    }

    if (url.includes("/rest/v1/image_prompt_generations") && method === "POST") {
      return Response.json([{ id: 501 }]);
    }

    if (url.includes("/rest/v1/story_media") && method === "POST") {
      writes.storyMedia.push(JSON.parse(init.body));
      return Response.json([]);
    }

    throw new Error(`Unexpected fetch call: ${url} ${method}`);
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  });

  const response = await worker.fetch(new Request("https://example.com/admin/media/generate", {
    method: "POST",
    headers: {
      authorization: "Bearer admin-secret",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      storyId: 12345,
      recrawl: true,
      applyToStory: true,
      replaceStoryContent: true,
      logPromptRun: false
    })
  }), {
    ...env,
    ADMIN_API_KEY: "admin-secret",
    FAL_API_KEY: "fal-test-key",
    OPENAI_API_KEY: "openai-test-key",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SECRET_KEY: "service-role-test",
    CLOUDFLARE_ACCOUNT_ID: "account-123",
    CLOUDFLARE_API_TOKEN: "token-123",
    PUBLIC_MEDIA_BASE_URL: "https://media.example.com",
    MEDIA_BUCKET: bucket,
    VISUAL_FEED_CACHE: createKvNamespace()
  });

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.applied, true);
  assert.equal(payload.replacedStoryContent, true);
  assert.equal(writes.storyMedia.length, 1);
  assert.notEqual(payload.appliedResult.mediaUrl, "https://media.example.com/stories/12345-old.webp");
  assert.match(writes.storyMedia[0].media_key, /^stories\/12345-[a-f0-9]+-[a-f0-9-]+\.webp$/);
  assert.equal(writes.storyContent.length, 1);
  assert.equal(writes.storyContent[0].source_kind, "crawl");
  assert.equal(writes.storyContent[0].summary, "Recrawled summary");
  assert.equal(writes.storyContent[0].ai_headline, "Recrawled headline");
  assert.equal(writes.storyContent[0].explanation, null);
  assert.equal(bucket.objects.has("stories/12345-old.webp"), false);
});

test("admin test prompt can save a preview and apply it to overwrite an existing item", async (t) => {
  const originalFetch = globalThis.fetch;
  const bucket = createMemoryBucket();
  const writes = {
    storyMedia: [],
    storyContent: [],
    promptRunEvents: [],
    promptGenerations: []
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

    if (url === "https://api.openai.com/v1/chat/completions") {
      return Response.json({
        choices: [
          {
            message: {
              content: "Optimized editorial prompt for manual admin article."
            }
          }
        ]
      });
    }

    if (url.includes("/rest/v1/story_content")) {
      if (method === "GET") {
        if (url.includes("select=summary%2Cextracted_text%2Cai_headline%2Ctopics")) {
          return Response.json({
            summary: null,
            extracted_text: null,
            ai_headline: null,
            topics: []
          });
        }
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

    if (url.includes("/rest/v1/image_prompt_optimizer_configs") && method === "GET") {
      return Response.json([{
        id: 91,
        key: "news_image_prompt_optimizer",
        version: "v1.1-a",
        name: "News Image Prompt Optimizer - Production Generalist",
        optimizer_provider: "openai",
        optimizer_model: "gpt-5.4-mini-2026-03-17",
        generation_provider: "fal",
        generation_model: "fal-ai/flux-2/turbo",
        max_completion_tokens: 500,
        system_prompt: "system",
        user_prompt_template: "template",
        topic_matchers: ["technology"],
        keyword_matchers: [],
        routing_priority: 100,
        fallback: true,
        settings: {},
        active: true
      }]);
    }

    if (url.includes("/rest/v1/image_prompt_generations") && method === "POST") {
      writes.promptGenerations.push(JSON.parse(init.body));
      return Response.json([{ id: 501 }]);
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
    OPENAI_API_KEY: "openai-test-key",
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
  assert.equal(previewPayload.resolvedPrompt, "Optimized editorial prompt for manual admin article.");
  assert.equal(previewPayload.approval.canApply, true);
  assert.equal(previewPayload.resolvedContent.sourceKind, "provided");
  assert.equal(previewPayload.r2Url, previewPayload.approval.testAssetUrl);
  assert.equal(writes.promptGenerations.length, 1);

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
  assert.match(applyPayload.mediaKey, /^stories\/12345-[a-f0-9]+-[a-f0-9-]+\.webp$/);
  assert.equal(applyPayload.mediaUrl, writes.storyMedia[0].media_url);
  assert.notEqual(applyPayload.mediaUrl, "https://media.example.com/old.webp");
  assert.equal(publishedEntry.media_status, "ready");
  assert.equal(writes.storyMedia.length, 1);
  assert.equal(writes.storyMedia[0].story_id, 12345);
  assert.equal(writes.storyContent.length > 0, true);
  assert.equal(bucket.objects.has(previewPayload.approval.testManifestKey), true);
  assert.equal(bucket.objects.has("old.webp"), false);
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
    if (url === "https://api.openai.com/v1/chat/completions") {
      return Response.json({
        choices: [
          {
            message: {
              content: "Optimized prompt from async crawl task."
            }
          }
        ]
      });
    }
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
    OPENAI_API_KEY: "openai-test-key",
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
  assert.equal(promptPayload.status, "resolved");
  assert.equal(promptPayload.resolvedPrompt, "Optimized prompt from async crawl task.");
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

test("visual feed prefers story_media media_url over stale published entry media_url", async (t) => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";

    if (url.includes("/rpc/get_visual_feed") && method === "POST") {
      return Response.json([{
        story_id: 12345,
        publish_sequence: 77,
        source_endpoint: "general",
        published_at: "2026-04-02T12:44:40.754+00:00",
        media_url: "https://api-staging.newsroll.app/media/stories/bad.webp",
        media_status: "ready",
        headline: null
      }]);
    }

    if (url.includes("/rest/v1/story_content") && method === "GET") {
      return Response.json([{
        story_id: 12345,
        source_url: "https://example.com/story"
      }]);
    }

    if (url.includes("/rest/v1/story_media") && method === "GET") {
      return Response.json([{
        story_id: 12345,
        media_url: "https://media-staging.newsroll.app/stories/good.webp"
      }]);
    }

    throw new Error(`Unexpected fetch call: ${url} ${method}`);
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const res = await worker.fetch(new Request("https://example.com/v1/visual-feed?limit=1"), {
    ...env,
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SECRET_KEY: "service-role-test"
  });

  assert.equal(res.status, 200);
  const payload = await res.json();
  assert.equal(payload.items[0].mediaUrl, "https://media-staging.newsroll.app/stories/good.webp");
});

test("GET /admin/stories/:storyId returns current story data", async (t) => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";

    if (url.includes("/rest/v1/published_feed_entries") && method === "GET") {
      return Response.json([{
        story_id: 12345,
        publish_sequence: 77,
        source_endpoint: "tech",
        published_at: "2026-04-15T09:00:00Z",
        media_url: "https://api-staging.newsroll.app/media/stories/stale.webp",
        media_status: "ready",
        headline: "Published headline",
        media_type: "image",
        media_provider: "fal",
        media_model: "fal-ai/flux-2/turbo",
        generation_status: "ready",
        generation_latency_ms: 2345,
        generation_cost_usd: 0.02,
        engagement_count: 15,
        impression_count: 120
      }]);
    }

    if (url.includes("/rest/v1/story_content") && method === "GET") {
      return Response.json({
        story_id: 12345,
        source_kind: "crawl",
        extracted_text: "Current extracted story text",
        ai_headline: "AI headline",
        source_url: "https://example.com/story",
        feed_url: "https://example.com/feed.xml",
        summary: "Current summary",
        explanation: "Current explanation",
        explanation_json: { title: "Explain title", sections: [] },
        topics: ["ai", "media"],
        updated_at: "2026-04-15T09:05:00Z"
      });
    }

    if (url.includes("/rest/v1/story_media") && method === "GET") {
      return Response.json({
        story_id: 12345,
        status: "ready",
        fal_request_id: "fal-request-1",
        media_key: "stories/12345-hash.webp",
        media_url: "https://media.example.com/story.webp",
        failure_reason: null,
        attempts: 1,
        image_prompt: "Current image prompt",
        image_prompt_generation_id: 91,
        optimizer_config_id: 7,
        media_type: "image",
        provider: "fal",
        model: "fal-ai/flux-2/turbo",
        generation_latency_ms: 2345,
        updated_at: "2026-04-15T09:06:00Z"
      });
    }

    if (url.includes("/rest/v1/rss_items") && method === "GET") {
      return Response.json({
        url: "https://example.com/story",
        canonical_url: "https://example.com/story-canonical",
        rss_sources: {
          feed_url: "https://example.com/feed.xml",
          tier: 1
        }
      });
    }

    throw new Error(`Unexpected fetch call: ${url} ${method}`);
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const res = await worker.fetch(new Request("https://example.com/admin/stories/12345", {
    headers: { authorization: "Bearer admin-secret" }
  }), {
    ...env,
    ADMIN_API_KEY: "admin-secret",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SECRET_KEY: "service-role-test"
  });

  assert.equal(res.status, 200);
  const payload = await res.json();
  assert.equal(payload.storyId, 12345);
  assert.equal(payload.publishedEntry.publishSequence, 77);
  assert.equal(Object.hasOwn(payload.publishedEntry, "mediaUrl"), false);
  assert.equal(payload.storyContent.extractedText, "Current extracted story text");
  assert.equal(payload.storyMedia.imagePrompt, "Current image prompt");
  assert.equal(payload.storyMedia.mediaUrl, "https://media.example.com/story.webp");
  assert.equal(payload.sourceMetadata.canonicalUrl, "https://example.com/story-canonical");
});

test("GET /admin/stories/:storyId returns 404 when story data is missing", async (t) => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";

    if (url.includes("/rest/v1/published_feed_entries") && method === "GET") {
      return Response.json([]);
    }

    if (url.includes("/rest/v1/story_content") && method === "GET") {
      return Response.json(null);
    }

    if (url.includes("/rest/v1/story_media") && method === "GET") {
      return Response.json(null);
    }

    if (url.includes("/rest/v1/rss_items") && method === "GET") {
      return Response.json(null);
    }

    throw new Error(`Unexpected fetch call: ${url} ${method}`);
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const res = await worker.fetch(new Request("https://example.com/admin/stories/98765", {
    headers: { authorization: "Bearer admin-secret" }
  }), {
    ...env,
    ADMIN_API_KEY: "admin-secret",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SECRET_KEY: "service-role-test"
  });

  assert.equal(res.status, 404);
  const payload = await res.json();
  assert.equal(payload.details.storyId, 98765);
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
