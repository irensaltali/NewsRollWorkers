import test from "node:test";
import assert from "node:assert/strict";

import { buildFalImageRequest, dailyMediaLimit, meetsMediaQualityGate, processMediaMessage } from "../src/media-pipeline.mjs";
import { publicMediaUrlFor, MEDIA_DAILY_LIMIT_DEFAULT, MEDIA_MAX_QUEUE_RETRIES, MEDIA_MIN_SCORE_DEFAULT } from "../src/config.mjs";
import { cleanupStaleMedia } from "../src/d1.mjs";

test("FAL image request uses flux-2/turbo settings", () => {
  const payload = buildFalImageRequest("prompt");

  assert.equal(payload.image_size, "portrait_16_9");
  assert.equal(payload.num_images, 1);
  assert.equal(payload.output_format, "webp");
  assert.equal(payload.guidance_scale, 2.5);
  assert.equal(payload.enable_safety_checker, true);
  assert.equal(payload.enable_prompt_expansion, true);
});

test("publicMediaUrlFor prefers the explicit media host when configured", () => {
  const mediaUrl = publicMediaUrlFor(
    {
      PUBLIC_API_BASE_URL: "https://api-staging.newsroll.com",
      PUBLIC_MEDIA_BASE_URL: "https://media-staging.newsroll.com/"
    },
    "stories/example.jpg"
  );

  assert.equal(mediaUrl, "https://media-staging.newsroll.com/stories/example.jpg");
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

// --- Dead-letter tests ---

test("processMediaMessage dead-letters after max retries", async () => {
  let upsertedStatus = null;
  let acked = false;

  const message = {
    body: { storyId: 999, endpoint: "front", title: "Test", url: null },
    attempts: MEDIA_MAX_QUEUE_RETRIES,
    ack() { acked = true; },
    retry() { throw new Error("should not retry"); }
  };

  const env = {
    DB: {
      prepare() {
        return {
          bind() {
            return {
              async run() {},
              async first() { return null; },
              async all() { return { results: [] }; }
            };
          }
        };
      }
    }
  };

  // Monkey-patch upsertMedia via the D1 mock to capture the status
  const originalPrepare = env.DB.prepare;
  env.DB.prepare = function (sql) {
    if (sql.includes("story_media")) {
      return {
        bind(...args) {
          // args[1] is the status field in upsertMedia
          upsertedStatus = args[1];
          return { async run() {} };
        }
      };
    }
    return originalPrepare.call(this, sql);
  };

  await processMediaMessage({ messages: [message] }, env);

  assert.equal(acked, true, "message should be acked after dead-lettering");
  assert.equal(upsertedStatus, "dead_letter", "status should be dead_letter");
});

test("processMediaMessage retries with exponential backoff on failure", async () => {
  let retryArgs = null;

  const message = {
    body: { storyId: 123, endpoint: "front", title: "Test", url: "https://example.com" },
    attempts: 1,
    ack() { throw new Error("should not ack"); },
    retry(opts) { retryArgs = opts; }
  };

  // Provide an env that will cause a failure during processing
  const env = {
    DB: {
      prepare() {
        return {
          bind() {
            return {
              async run() { throw new Error("simulated DB failure"); },
              async first() { throw new Error("simulated DB failure"); },
              async all() { throw new Error("simulated DB failure"); }
            };
          }
        };
      }
    }
  };

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

test("cleanupStaleMedia executes delete query with correct days parameter", async () => {
  let boundDays = null;
  const mockDb = {
    prepare(sql) {
      return {
        bind(days) {
          boundDays = days;
          return {
            async run() { return { meta: { changes: 3 } }; }
          };
        }
      };
    }
  };

  const deleted = await cleanupStaleMedia({ DB: mockDb }, 14);
  assert.equal(deleted, 3);
  assert.equal(boundDays, 14);
});
