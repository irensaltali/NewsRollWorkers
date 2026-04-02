import test from "node:test";
import assert from "node:assert/strict";

import {
  querySeenStoryIds,
  queryStoryVelocityWindow,
  writeEventBatch
} from "../src/event-analytics.mjs";

test("writeEventBatch writes enriched event rows to Analytics Engine", async () => {
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
    topicPrimary: "ai",
    aiAction: null,
    topics: ["ai", "startups"],
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
      "ai",
      "",
      "[\"ai\",\"startups\"]",
      "evt-1"
    ],
    doubles: [1, 0.05, 0, 0]
  }]);
});

test("querySeenStoryIds reads distinct story ids from Analytics Engine SQL API", async () => {
  const env = {
    CLOUDFLARE_ACCOUNT_ID: "acct-1",
    CLOUDFLARE_API_TOKEN: "token-1",
    EVENT_ANALYTICS_DATASET: "newsroll_user_events"
  };

  let query = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    query = init.body;
    return new Response(JSON.stringify({
      data: [{ story_id: "123" }, { story_id: "456" }]
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  try {
    const storyIds = await querySeenStoryIds(env, "user-1", 7);
    assert.deepEqual(storyIds, [123, 456]);
    assert.match(query, /FROM newsroll_user_events/);
    assert.match(query, /blob1 = 'user-1'/);
    assert.match(query, /blob3 = 'impression'/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("queryStoryVelocityWindow aggregates event counts from Analytics Engine SQL API", async () => {
  const env = {
    CLOUDFLARE_ACCOUNT_ID: "acct-1",
    CLOUDFLARE_API_TOKEN: "token-1",
    EVENT_ANALYTICS_DATASET: "newsroll_user_events"
  };

  let query = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    query = init.body;
    return new Response(JSON.stringify({
      data: [{
        imp: 10,
        eng: 4,
        saves: 1,
        skips: 2,
        completes: 1,
        detail_opens: 1,
        shares: 0,
        hides: 1,
        ai_actions: 2
      }]
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  try {
    const row = await queryStoryVelocityWindow(env, 987, 30);
    assert.equal(row.imp, 10);
    assert.equal(row.ai_actions, 2);
    assert.match(query, /blob2 = '987'/);
    assert.match(query, /INTERVAL '30' MINUTE/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
