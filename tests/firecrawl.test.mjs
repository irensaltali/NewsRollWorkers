import test from "node:test";
import assert from "node:assert/strict";

import {
  parseFirecrawlApiKeys,
  isFirecrawlConfigured,
  selectNextKey,
  mapFirecrawlMetadata,
  firecrawlScrapeUrl
} from "../src/firecrawl.mjs";

// ── parseFirecrawlApiKeys ────────────────────────────────────────────

test("parseFirecrawlApiKeys splits comma-separated keys", () => {
  const keys = parseFirecrawlApiKeys({ FIRECRAWL_API_KEYS: "fc-a,fc-b,fc-c" });
  assert.deepEqual(keys, ["fc-a", "fc-b", "fc-c"]);
});

test("parseFirecrawlApiKeys trims whitespace from keys", () => {
  const keys = parseFirecrawlApiKeys({ FIRECRAWL_API_KEYS: " fc-a , fc-b , fc-c " });
  assert.deepEqual(keys, ["fc-a", "fc-b", "fc-c"]);
});

test("parseFirecrawlApiKeys handles single key", () => {
  const keys = parseFirecrawlApiKeys({ FIRECRAWL_API_KEYS: "fc-only" });
  assert.deepEqual(keys, ["fc-only"]);
});

test("parseFirecrawlApiKeys returns empty array for empty string", () => {
  const keys = parseFirecrawlApiKeys({ FIRECRAWL_API_KEYS: "" });
  assert.deepEqual(keys, []);
});

test("parseFirecrawlApiKeys returns empty array for undefined", () => {
  const keys = parseFirecrawlApiKeys({});
  assert.deepEqual(keys, []);
});

test("parseFirecrawlApiKeys filters out empty segments from trailing comma", () => {
  const keys = parseFirecrawlApiKeys({ FIRECRAWL_API_KEYS: "fc-a,fc-b," });
  assert.deepEqual(keys, ["fc-a", "fc-b"]);
});

// ── isFirecrawlConfigured ────────────────────────────────────────────

test("isFirecrawlConfigured returns true when keys present", () => {
  assert.equal(isFirecrawlConfigured({ FIRECRAWL_API_KEYS: "fc-a" }), true);
});

test("isFirecrawlConfigured returns false when no keys", () => {
  assert.equal(isFirecrawlConfigured({}), false);
});

test("isFirecrawlConfigured returns false for empty string", () => {
  assert.equal(isFirecrawlConfigured({ FIRECRAWL_API_KEYS: "" }), false);
});

// ── mapFirecrawlMetadata ─────────────────────────────────────────────

test("mapFirecrawlMetadata maps Firecrawl metadata to article format", () => {
  const result = mapFirecrawlMetadata({
    metadata: {
      title: "Test Article",
      description: "A test article about testing",
      language: "en",
      ogTitle: "OG Test Article",
      ogDescription: "OG description"
    }
  });

  assert.equal(result.title, "OG Test Article");
  assert.equal(result.headline, "OG description");
  assert.equal(result.language, "en");
  assert.equal(result.summary, "A test article about testing");
  assert.equal(result.topics, null);
});

test("mapFirecrawlMetadata falls back to title when ogTitle is missing", () => {
  const result = mapFirecrawlMetadata({
    metadata: {
      title: "Fallback Title",
      description: "Some desc"
    }
  });

  assert.equal(result.title, "Fallback Title");
  assert.equal(result.headline, "Some desc");
});

test("mapFirecrawlMetadata returns null for empty metadata", () => {
  const result = mapFirecrawlMetadata({});
  assert.equal(result, null);
});

test("mapFirecrawlMetadata returns null for null input", () => {
  const result = mapFirecrawlMetadata(null);
  assert.equal(result, null);
});

// ── selectNextKey ────────────────────────────────────────────────────

test("selectNextKey picks first key when KV is empty", async () => {
  const kvStore = {};
  const env = {
    VISUAL_FEED_CACHE: {
      get: async (key) => kvStore[key] ?? null,
      put: async (key, value) => { kvStore[key] = value; }
    }
  };

  const result = await selectNextKey(env, ["fc-a", "fc-b", "fc-c"]);
  assert.equal(result.apiKey, "fc-a");
  assert.equal(result.keyIndex, 0);
});

test("selectNextKey advances round-robin index", async () => {
  const kvStore = { "firecrawl:rr:index": "1" };
  const env = {
    VISUAL_FEED_CACHE: {
      get: async (key) => kvStore[key] ?? null,
      put: async (key, value) => { kvStore[key] = value; }
    }
  };

  const result = await selectNextKey(env, ["fc-a", "fc-b", "fc-c"]);
  assert.equal(result.apiKey, "fc-b");
  assert.equal(result.keyIndex, 1);
});

test("selectNextKey wraps around to first key", async () => {
  const kvStore = { "firecrawl:rr:index": "2" };
  const env = {
    VISUAL_FEED_CACHE: {
      get: async (key) => kvStore[key] ?? null,
      put: async (key, value) => { kvStore[key] = value; }
    }
  };

  const result = await selectNextKey(env, ["fc-a", "fc-b", "fc-c"]);
  assert.equal(result.apiKey, "fc-c");
  assert.equal(result.keyIndex, 2);
  // Next call should wrap to 0
  assert.equal(kvStore["firecrawl:rr:index"], "0");
});

test("selectNextKey returns null for empty keys array", async () => {
  const result = await selectNextKey({}, []);
  assert.equal(result, null);
});

// ── firecrawlScrapeUrl ───────────────────────────────────────────────

test("firecrawlScrapeUrl returns config_error when no keys configured", async () => {
  const result = await firecrawlScrapeUrl({}, "https://example.com");
  assert.equal(result.success, false);
  assert.equal(result.failureKind, "config_error");
  assert.equal(result.provider, "firecrawl");
});

test("firecrawlScrapeUrl calls Firecrawl API and returns markdown", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), "https://api.firecrawl.dev/v1/scrape");
      const body = JSON.parse(init.body);
      assert.equal(body.url, "https://example.com/article");
      assert.deepEqual(body.formats, ["markdown"]);
      assert.equal(body.onlyMainContent, true);
      return Response.json({
        success: true,
        data: {
          markdown: "# Test Article\n\nContent here.",
          metadata: {
            title: "Test Article",
            description: "Article about testing",
            language: "en"
          }
        }
      });
    };

    const kvStore = {};
    const env = {
      FIRECRAWL_API_KEYS: "fc-test-key",
      VISUAL_FEED_CACHE: {
        get: async (key) => kvStore[key] ?? null,
        put: async (key, value) => { kvStore[key] = value; }
      }
    };

    const result = await firecrawlScrapeUrl(env, "https://example.com/article", { storyId: 123 });
    assert.equal(result.success, true);
    assert.equal(result.provider, "firecrawl");
    assert.equal(result.markdown, "# Test Article\n\nContent here.");
    assert.equal(result.metadata?.title, "Test Article");
    assert.equal(result.failureKind, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("firecrawlScrapeUrl handles API error responses", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => {
      return new Response(JSON.stringify({ error: "Rate limited" }), { status: 429 });
    };

    const kvStore = {};
    const env = {
      FIRECRAWL_API_KEYS: "fc-test-key",
      VISUAL_FEED_CACHE: {
        get: async (key) => kvStore[key] ?? null,
        put: async (key, value) => { kvStore[key] = value; }
      }
    };

    const result = await firecrawlScrapeUrl(env, "https://example.com");
    assert.equal(result.success, false);
    assert.equal(result.provider, "firecrawl");
    assert.equal(result.failureKind, "http_error");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
