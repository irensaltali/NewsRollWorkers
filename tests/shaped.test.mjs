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
          category: null,
          source_endpoint: null,
          media_url: null,
          media_type: null,
          media_provider: null,
          media_model: null,
          prompt_template_id: null,
          prompt_template_name: null,
          duplicate_cluster_size: 1
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

test("upsertItem flattens crawled topic arrays into the Shaped category field", async () => {
  const env = {
    SHAPED_API_KEY: "test-key"
  };

  await withMockedFetch(async (_input, init) => {
    assert.equal(JSON.parse(init.body).data[0].category, "ai, startups, funding");
    return new Response("", { status: 200 });
  }, async () => {
    const result = await upsertItem(env, {
      storyId: 456,
      category: ["ai", "startups", "funding"],
      sourceEndpoint: "business"
    });
    assert.deepEqual(result, { ok: true });
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
          feed_mode: null,
          dwell_ms: null,
          media_type: null,
          source_endpoint: null,
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
