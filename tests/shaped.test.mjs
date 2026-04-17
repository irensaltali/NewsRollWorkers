import test from "node:test";
import assert from "node:assert/strict";

import { upsertItem, queryPersonalizedFeed, trackEvents } from "../src/shaped.mjs";

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
          title: null,
          summary: null,
          category: null,
          topics: null,
          media_url: null,
          media_type: null,
          media_provider: null,
          media_model: null,
          optimizer_config_id: null
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
    const item = JSON.parse(init.body).data[0];
    assert.deepEqual(item.topics, ["ai", "startups", "funding"]);
    assert.equal(item.category, "business");
    assert.equal(item.summary, "Funding round analysis");
    return new Response("", { status: 200 });
  }, async () => {
    const result = await upsertItem(env, {
      storyId: 456,
      topics: ["ai", "startups", "funding"],
      category: "business",
      summary: "Funding round analysis"
    });
    assert.deepEqual(result, { ok: true });
  });
});

test("queryPersonalizedFeed sends pagination_key and returns results with paginationKey", async () => {
  const env = {
    SHAPED_API_KEY: "test-key",
    SHAPED_ENGINE_NAME: "custom_engine"
  };

  await withMockedFetch(async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    assert.equal(url, "https://api.shaped.ai/v2/engines/custom_engine/queries/personalized_trending_feed");
    assert.equal(init.method, "POST");
    const body = JSON.parse(init.body);
    assert.equal(body.parameters.user_id, "user-1");
    assert.equal(body.parameters.count, 10);
    assert.equal(body.pagination_key, "user-1_1700000000000");
    return new Response(JSON.stringify({
      results: [
        { id: "42", score: 0.95 },
        { id: "7", score: 0.80 }
      ],
      pagination_key: "user-1_1700000000000"
    }), { status: 200 });
  }, async () => {
    const result = await queryPersonalizedFeed(env, "user-1", {
      count: 10,
      paginationKey: "user-1_1700000000000"
    });
    assert.deepEqual(result.results, [
      { id: "42", score: 0.95 },
      { id: "7", score: 0.80 }
    ]);
    assert.equal(result.paginationKey, "user-1_1700000000000");
  });
});

test("queryPersonalizedFeed returns null paginationKey when Shaped omits it (last page)", async () => {
  const env = { SHAPED_API_KEY: "test-key" };

  await withMockedFetch(async () => {
    return new Response(JSON.stringify({
      results: [{ id: "99", score: 0.5 }]
    }), { status: 200 });
  }, async () => {
    const result = await queryPersonalizedFeed(env, "user-2", { count: 20 });
    assert.equal(result.results.length, 1);
    assert.equal(result.paginationKey, null);
  });
});

test("queryPersonalizedFeed omits pagination_key from request when not provided", async () => {
  const env = { SHAPED_API_KEY: "test-key" };

  await withMockedFetch(async (_input, init) => {
    const body = JSON.parse(init.body);
    assert.equal(Object.prototype.hasOwnProperty.call(body, "pagination_key"), false);
    return new Response(JSON.stringify({ results: [] }), { status: 200 });
  }, async () => {
    const result = await queryPersonalizedFeed(env, "user-3");
    assert.deepEqual(result, { results: [], paginationKey: null });
  });
});

test("queryPersonalizedFeed returns empty results on failure", async () => {
  const env = { SHAPED_API_KEY: "test-key" };

  await withMockedFetch(async () => {
    return new Response("Internal Server Error", { status: 500 });
  }, async () => {
    const result = await queryPersonalizedFeed(env, "user-4");
    assert.deepEqual(result, { results: [], paginationKey: null });
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
          event_type: "impression",
          label: null,
          session_id: null,
          surface: "unknown",
          feed_mode: null,
          dwell_ms: null,
          media_type: null,
          topics: null,
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
      const result = await trackEvents(env, "user-1", [{ storyId: 123, eventType: "impression" }]);
      assert.deepEqual(result, { ok: true });
    } finally {
      crypto.randomUUID = originalRandomUUID;
      Date.now = originalDateNow;
      Date.prototype.toISOString = originalDateToISOString;
    }
  });
});
