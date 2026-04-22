import test from "node:test";
import assert from "node:assert/strict";

import { buildFalImageRequest, dailyMediaLimit, isPermanentCrawlError, mediaPerRunLimit, meetsMediaQualityGate, needsMediaCrawl, processMediaMessage } from "../src/media-pipeline.mjs";
import { publicMediaUrlFor, MEDIA_DAILY_LIMIT_DEFAULT, MEDIA_MAX_QUEUE_RETRIES, MEDIA_MIN_SCORE_DEFAULT, MEDIA_PER_RUN_LIMIT_DEFAULT } from "../src/config.mjs";
import { cleanupStaleMedia } from "../src/db.mjs";
import { mediaTemplateWithFallback } from "../src/prompt-config.mjs";

test("FAL image request uses flux-2/turbo settings", () => {
  const payload = buildFalImageRequest("prompt");

  assert.equal(payload.image_size, "portrait_16_9");
  assert.equal(payload.num_images, 1);
  assert.equal(payload.output_format, "webp");
  assert.equal(payload.guidance_scale, 2.5);
  assert.equal(payload.enable_safety_checker, true);
  assert.equal(payload.enable_prompt_expansion, true);
});

test("mediaTemplateWithFallback uses the canonical fal image model id", () => {
  const template = mediaTemplateWithFallback(null, "image");

  assert.equal(template.model, "fal-ai/flux-2/turbo");
});

test("isPermanentCrawlError flags origin 401/403 and robots blocks", () => {
  assert.equal(isPermanentCrawlError("HTTP 401 Unauthorized"), true);
  assert.equal(isPermanentCrawlError("403 Forbidden"), true);
  assert.equal(isPermanentCrawlError("Disallowed by robots.txt"), true);
  assert.equal(isPermanentCrawlError("Crawl completely disallowed by robots.txt"), true);
});

test("isPermanentCrawlError ignores transient and infra failures", () => {
  assert.equal(isPermanentCrawlError("Cloudflare crawl API error (401): Authentication error"), false);
  assert.equal(isPermanentCrawlError("Cloudflare crawl API error (403): Invalid API token"), false);
  assert.equal(isPermanentCrawlError("Cloudflare crawl job did not complete within timeout"), false);
  assert.equal(isPermanentCrawlError("HTTP 404 Not Found"), false);
  assert.equal(isPermanentCrawlError("HTTP 429 Too Many Requests"), false);
  assert.equal(isPermanentCrawlError("HTTP 500 Internal Server Error"), false);
  assert.equal(isPermanentCrawlError(""), false);
  assert.equal(isPermanentCrawlError(null), false);
});

test("publicMediaUrlFor prefers the explicit media host when configured", () => {
  const mediaUrl = publicMediaUrlFor(
    {
      PUBLIC_API_BASE_URL: "https://api-staging.newsroll.app",
      PUBLIC_MEDIA_BASE_URL: "https://media-staging.newsroll.app/"
    },
    "stories/example.jpg"
  );

  assert.equal(mediaUrl, "https://media-staging.newsroll.app/stories/example.jpg");
});

// --- Daily media limit tests ---

test("dailyMediaLimit returns default for production without env override", () => {
  assert.equal(dailyMediaLimit({ ENVIRONMENT: "production" }), MEDIA_DAILY_LIMIT_DEFAULT);
});

test("dailyMediaLimit respects MEDIA_DAILY_LIMIT env var in production", () => {
  assert.equal(dailyMediaLimit({ ENVIRONMENT: "production", MEDIA_DAILY_LIMIT: "200" }), 200);
});

test("dailyMediaLimit respects MEDIA_DAILY_LIMIT env var in staging", () => {
  assert.equal(dailyMediaLimit({ ENVIRONMENT: "staging", MEDIA_DAILY_LIMIT: "15" }), 15);
});

test("dailyMediaLimit still supports legacy STAGING_MEDIA_DAILY_LIMIT in staging", () => {
  assert.equal(dailyMediaLimit({ ENVIRONMENT: "staging", STAGING_MEDIA_DAILY_LIMIT: "15" }), 15);
});

test("dailyMediaLimit defaults to 10 for staging without explicit var", () => {
  assert.equal(dailyMediaLimit({ ENVIRONMENT: "staging" }), 10);
});

test("dailyMediaLimit falls back to default on invalid value", () => {
  assert.equal(dailyMediaLimit({ ENVIRONMENT: "production", MEDIA_DAILY_LIMIT: "abc" }), MEDIA_DAILY_LIMIT_DEFAULT);
});

test("mediaPerRunLimit returns default without env override", () => {
  assert.equal(mediaPerRunLimit({}), MEDIA_PER_RUN_LIMIT_DEFAULT);
});

test("mediaPerRunLimit defaults to 1 for staging without explicit var", () => {
  assert.equal(mediaPerRunLimit({ ENVIRONMENT: "staging" }), 1);
});

test("mediaPerRunLimit respects MEDIA_PER_RUN_LIMIT env var", () => {
  assert.equal(mediaPerRunLimit({ MEDIA_PER_RUN_LIMIT: "7" }), 7);
});

test("mediaPerRunLimit falls back to default on invalid value", () => {
  assert.equal(mediaPerRunLimit({ MEDIA_PER_RUN_LIMIT: "abc" }), MEDIA_PER_RUN_LIMIT_DEFAULT);
});

test("needsMediaCrawl only requests a crawl when the message has a URL and no cached text", () => {
  assert.equal(needsMediaCrawl({ url: "https://example.com/story" }, { text: "" }), true);
  assert.equal(needsMediaCrawl({ url: "https://example.com/story" }, { text: "Cached RSS summary" }), false);
  assert.equal(needsMediaCrawl({ url: null }, { text: "" }), false);
});


test("processMediaMessage stops when crawl metadata is missing", async () => {
  let acked = false;
  let retried = false;

  const message = {
    body: { storyId: 123, endpoint: "front", title: "Test", url: "https://example.com" },
    attempts: 0,
    ack() { acked = true; },
    retry() { retried = true; }
  };

  await processMediaMessage({ messages: [message] }, {});

  assert.equal(acked, true);
  assert.equal(retried, false);
});

// --- Dead-letter tests ---

test("processMediaMessage dead-letters after max retries", async () => {
  let acked = false;

  const message = {
    body: { storyId: 999, endpoint: "front", title: "Test", url: null },
    attempts: MEDIA_MAX_QUEUE_RETRIES,
    ack() { acked = true; },
    retry() { throw new Error("should not retry"); }
  };

  await processMediaMessage({ messages: [message] }, {});

  assert.equal(acked, true, "message should be acked after dead-lettering");
});

test("processMediaMessage retries with exponential backoff on failure", async () => {
  let retryArgs = null;

  const message = {
    body: { storyId: 123, endpoint: "front", title: "Test", url: "https://example.com" },
    attempts: 1,
    ack() { throw new Error("should not ack"); },
    retry(opts) { retryArgs = opts; }
  };

  // Env with no backend configured — processing will reach message.ack() which throws,
  // causing the catch block to call message.retry() with exponential backoff.
  const env = {};

  await processMediaMessage({ messages: [message] }, env);

  assert.ok(retryArgs, "message.retry should have been called");
  assert.equal(retryArgs.delaySeconds, 60, "delay should be 30 * 2^1 = 60 seconds");
});

// --- Quality gate tests ---

test("meetsMediaQualityGate passes stories above threshold on scored endpoints", () => {
  assert.equal(meetsMediaQualityGate({}, "front", { score: 10 }), true);
  assert.equal(meetsMediaQualityGate({}, "best", { score: 5 }), true);
  assert.equal(meetsMediaQualityGate({}, "show", { score: 100 }), true);
  assert.equal(meetsMediaQualityGate({}, "ask", { score: MEDIA_MIN_SCORE_DEFAULT }), true);
});

test("meetsMediaQualityGate rejects low-score stories on scored endpoints", () => {
  assert.equal(meetsMediaQualityGate({}, "front", { score: 1 }), false);
  assert.equal(meetsMediaQualityGate({}, "best", { score: 0 }), false);
  assert.equal(meetsMediaQualityGate({}, "show", { score: 4 }), false);
  assert.equal(meetsMediaQualityGate({}, "ask", {}), false);
});

test("meetsMediaQualityGate rejects low-score stories regardless of category", () => {
  assert.equal(meetsMediaQualityGate({}, "general", { score: 0 }), false);
  assert.equal(meetsMediaQualityGate({}, "tech", { score: 0 }), false);
});

test("meetsMediaQualityGate respects MEDIA_MIN_SCORE env override", () => {
  assert.equal(meetsMediaQualityGate({ MEDIA_MIN_SCORE: "20" }, "front", { score: 15 }), false);
  assert.equal(meetsMediaQualityGate({ MEDIA_MIN_SCORE: "20" }, "front", { score: 20 }), true);
});

// --- Stale media cleanup tests ---

test("cleanupStaleMedia returns 0 when no DB is available", async () => {
  assert.equal(await cleanupStaleMedia({}), 0);
  assert.equal(await cleanupStaleMedia({ DB: null }), 0);
});

test("cleanupStaleMedia returns 0 when SUPABASE_URL is absent", async () => {
  assert.equal(await cleanupStaleMedia({ DB: {} }, 14), 0);
});

test("crawl-wait gate routes to Firecrawl status endpoint when crawlProvider is firecrawl", async () => {
  const originalFetch = globalThis.fetch;
  const hitUrls = [];
  const requeued = [];
  try {
    globalThis.fetch = async (input) => {
      const url = String(input);
      hitUrls.push(url);
      if (url === "https://api.firecrawl.dev/v2/batch/scrape/fc-1") {
        return Response.json({ status: "scraping" });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    const env = {
      FIRECRAWL_API_KEYS: "fc-key",
      MEDIA_QUEUE: {
        async send(message, opts) {
          requeued.push({ message, opts });
        }
      }
    };

    const message = {
      body: {
        kind: "crawl_check",
        storyId: 42,
        endpoint: "tech",
        url: "https://example.com/story",
        title: "Story",
        crawlJobId: "fc-1",
        crawlProvider: "firecrawl",
        crawlAttempts: 0
      },
      attempts: 0,
      ack() {},
      retry() { throw new Error("should not retry"); }
    };

    await processMediaMessage({ messages: [message] }, env);

    assert.ok(
      hitUrls.some((u) => u === "https://api.firecrawl.dev/v2/batch/scrape/fc-1"),
      `expected Firecrawl status hit, got ${JSON.stringify(hitUrls)}`
    );
    assert.ok(
      !hitUrls.some((u) => u.includes("browser-rendering")),
      "must not hit the Cloudflare browser-rendering endpoint"
    );
    assert.equal(requeued.length, 1, "running status should trigger a requeue");
    assert.equal(requeued[0].message.crawlAttempts, 1);
    assert.equal(requeued[0].opts.delaySeconds, 30);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
