import test from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.mjs";
import { signTestJWT, TEST_JWT_SECRET, TEST_USER_ID } from "./test-auth.mjs";

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
                  topicScores: "{}",
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
  assert.equal(payload.forYouFeed.enabled, false);
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

test("for-you cold-start fallback paginates fixture-style rows", async () => {
  const token = signTestJWT(TEST_USER_ID, TEST_JWT_SECRET);

  const firstPage = await worker.fetch(
    new Request("https://example.com/v1/feed/for-you?limit=1", {
      headers: { authorization: `Bearer ${token}` }
    }),
    env
  );

  assert.equal(firstPage.status, 200);
  const firstPayload = await firstPage.json();
  assert.equal(firstPayload.coldStart, true);
  assert.equal(firstPayload.items.length, 0); // no DB without SUPABASE_URL
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

