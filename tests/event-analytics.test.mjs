import test from "node:test";
import assert from "node:assert/strict";

import {
  writeEventBatch,
  queryEventAnalytics,
  hasEventAnalyticsQueryConfig
} from "../src/event-analytics.mjs";

test("writeEventBatch writes event rows to Analytics Engine", async () => {
  const writes = [];
  const env = {
    EVENT_ANALYTICS: {
      writeDataPoint(dataPoint) {
        writes.push(dataPoint);
      }
    }
  };

  const result = await writeEventBatch(env, "user-1", [{
    eventId: "evt-1",
    storyId: 123,
    eventType: "impression",
    sessionId: "session-1",
    surface: "feed",
    feedMode: "for_you",
    mediaType: "image",
    sourceEndpoint: "tech",
    aiAction: null,
    label: 0.05,
    dwellMs: 0,
    aiCreditsUsed: 0
  }]);

  assert.deepEqual(result, { stored: 1 });
  assert.deepEqual(writes, [{
    indexes: ["user-1"],
    blobs: [
      "user-1",
      "123",
      "impression",
      "session-1",
      "feed",
      "for_you",
      "image",
      "tech",
      "",
      "evt-1"
    ],
    doubles: [1, 0.05, 0, 0]
  }]);
});

test("queryEventAnalytics sends SQL query to Analytics Engine API", async () => {
  const env = {
    CLOUDFLARE_ACCOUNT_ID: "acct-1",
    CLOUDFLARE_API_TOKEN: "token-1",
    EVENT_ANALYTICS_DATASET: "newsroll_user_events"
  };

  let capturedQuery = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    capturedQuery = init.body;
    return new Response(JSON.stringify({
      data: [{ story_id: "123" }, { story_id: "456" }]
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  try {
    const sql = "SELECT blob2 AS story_id FROM newsroll_user_events WHERE blob1 = 'user-1' AND blob3 = 'impression' LIMIT 100";
    const rows = await queryEventAnalytics(env, sql);
    assert.deepEqual(rows, [{ story_id: "123" }, { story_id: "456" }]);
    assert.equal(capturedQuery, sql);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("hasEventAnalyticsQueryConfig returns false when config is missing", () => {
  assert.equal(hasEventAnalyticsQueryConfig({}), false);
  assert.equal(hasEventAnalyticsQueryConfig({ CLOUDFLARE_ACCOUNT_ID: "x" }), false);
  assert.equal(hasEventAnalyticsQueryConfig({ CLOUDFLARE_ACCOUNT_ID: "x", CLOUDFLARE_API_TOKEN: "y" }), true);
});
