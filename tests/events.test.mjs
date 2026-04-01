import test from "node:test";
import assert from "node:assert/strict";

import { validateEventBatch, VALID_EVENT_TYPES } from "../src/events.mjs";
import worker from "../src/index.mjs";
import { signTestJWT, TEST_JWT_SECRET, TEST_USER_ID } from "./test-auth.mjs";

const env = {
  APP_NAME: "NewsRoll",
  SUPABASE_JWT_SECRET: TEST_JWT_SECRET,
  PUBLIC_BASE_URL: "https://newsroll.invalid"
};

test("validateEventBatch rejects invalid event types", () => {
  const { valid, rejected } = validateEventBatch([
    { storyId: 1, eventType: "impression" },
    { storyId: 2, eventType: "invalid_type" },
    { storyId: 3, eventType: "vote" }
  ]);

  assert.equal(valid.length, 2);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason, "invalid eventType: invalid_type");
});

test("validateEventBatch rejects events with missing storyId", () => {
  const { valid, rejected } = validateEventBatch([
    { eventType: "impression" },
    { storyId: "not_a_number", eventType: "vote" }
  ]);

  assert.equal(valid.length, 0);
  assert.equal(rejected.length, 2);
});

test("validateEventBatch rejects non-positive storyId values", () => {
  const { valid, rejected } = validateEventBatch([
    { storyId: -1, eventType: "impression" },
    { storyId: 0, eventType: "vote" }
  ]);

  assert.equal(valid.length, 0);
  assert.equal(rejected.length, 2);
});

test("validateEventBatch accepts all valid event types", () => {
  const events = [...VALID_EVENT_TYPES].map((type, i) => ({
    storyId: i + 1,
    eventType: type
  }));

  const { valid, rejected } = validateEventBatch(events);
  assert.equal(valid.length, VALID_EVENT_TYPES.size);
  assert.equal(rejected.length, 0);
});

test("validateEventBatch handles non-array input", () => {
  const { valid, rejected } = validateEventBatch("not an array");
  assert.equal(valid.length, 0);
  assert.equal(rejected.length, 1);
});

test("events route returns 401 without auth", async () => {
  const response = await worker.fetch(
    new Request("https://example.com/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events: [{ storyId: 1, eventType: "impression" }] })
    }),
    env
  );

  assert.equal(response.status, 401);
});

test("events route returns 200 with valid auth and events", async () => {
  const token = signTestJWT(TEST_USER_ID, TEST_JWT_SECRET);

  const response = await worker.fetch(
    new Request("https://example.com/v1/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        events: [
          { storyId: 123, eventType: "impression" },
          { storyId: 456, eventType: "vote" },
          { storyId: 789, eventType: "bad_type" }
        ]
      })
    }),
    env
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.stored, 0); // storeEvents returns 0 without SUPABASE_URL
  assert.equal(payload.rejected, 1);
});
