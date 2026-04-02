import test from "node:test";
import assert from "node:assert/strict";

import { buildFalImageRequest, dailyMediaLimit, mediaPerRunLimit, meetsMediaQualityGate, needsMediaCrawl, processMediaMessage } from "../src/media-pipeline.mjs";
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
