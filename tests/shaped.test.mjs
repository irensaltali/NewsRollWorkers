import test from "node:test";
import assert from "node:assert/strict";

import { upsertItem, trackEvents } from "../src/shaped.mjs";

function withMockedFetch(handler, fn) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      globalThis.fetch = originalFetch;
    });
}

test("upsertItem sends item rows to the Shaped insert endpoint", async () => {
  const env = {
    SHAPED_API_KEY: "test-key",
    SHAPED_ITEMS_TABLE: "custom_items"
  };

  await withMockedFetch(async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    assert.equal(url, "https://api.shaped.ai/v2/tables/custom_items/insert");
    assert.equal(init.method, "POST");
    assert.equal(init.headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(init.body), {
      data: [
        {
          item_id: "123",
          created_at: "2025-01-01T00:00:00.000Z",
          updated_at: "2025-01-01T00:00:00.000Z",
          headline: null,
          publisher: null,
          source_endpoint: null,
          topics_text: null,
          entities_text: null,
          language: "en",
          quality_score: 0.5,
          novelty_score: 0.5,
          publisher_tier: 2,
          source_reliability_score: 0.5,
          media_type: null,
          media_provider: null,
          media_model: null,
          generation_status: null,
          prompt_template_id: null,
          prompt_template_name: null,
          article_length: null,
          has_author: false,
          topic_count: null,
          entity_count: null,
          duplicate_cluster_size: 1,
          ctr_5m: 0,
          ctr_30m: 0,
          ctr_2h: 0,
          save_rate_2h: 0,
          skip_rate_30m: 0,
          completion_rate_2h: 0,
          detail_open_rate_2h: 0,
          share_rate_2h: 0,
          hide_rate_2h: 0,
          ai_action_rate_24h: 0
        }
      ]
    });
    return new Response("", { status: 200 });
  }, async () => {
    const originalDateNow = Date.now;
    Date.now = () => 1735689600000;
    const originalDateToISOString = Date.prototype.toISOString;
    Date.prototype.toISOString = function toISOString() {
      return "2025-01-01T00:00:00.000Z";
    };
    try {
      const result = await upsertItem(env, { storyId: 123 });
      assert.deepEqual(result, { ok: true });
    } finally {
      Date.now = originalDateNow;
      Date.prototype.toISOString = originalDateToISOString;
    }
  });
});

test("trackEvents sends interaction rows to the Shaped insert endpoint", async () => {
  const env = {
    SHAPED_API_KEY: "test-key",
    SHAPED_INTERACTIONS_TABLE: "custom_interactions"
  };

  await withMockedFetch(async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    assert.equal(url, "https://api.shaped.ai/v2/tables/custom_interactions/insert");
    assert.equal(init.method, "POST");
    assert.equal(init.headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(init.body), {
      data: [
        {
          event_id: "fixed-event-id",
          user_id: "user-1",
          item_id: "123",
          created_at: "2025-01-01T00:00:00.000Z",
          event_type: "view",
          label: null,
          session_id: null,
          surface: "unknown",
          position: null,
          feed_mode: null,
          dwell_ms: null,
          media_type: null,
          source_endpoint: null,
          topic_primary: null,
          ai_action: null
        }
      ]
    });
    return new Response("", { status: 200 });
  }, async () => {
    const originalRandomUUID = crypto.randomUUID;
    crypto.randomUUID = () => "fixed-event-id";
    const originalDateNow = Date.now;
    Date.now = () => 1735689600000;
    const originalDateToISOString = Date.prototype.toISOString;
    Date.prototype.toISOString = function toISOString() {
      return "2025-01-01T00:00:00.000Z";
    };
    try {
      const result = await trackEvents(env, "user-1", [{ storyId: 123, eventType: "view" }]);
      assert.deepEqual(result, { ok: true });
    } finally {
      crypto.randomUUID = originalRandomUUID;
      Date.now = originalDateNow;
      Date.prototype.toISOString = originalDateToISOString;
    }
  });
});
