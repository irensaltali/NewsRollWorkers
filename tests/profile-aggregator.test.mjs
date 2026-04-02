import test from "node:test";
import assert from "node:assert/strict";

import { aggregateProfile, computeProfileData } from "../src/profile-aggregator.mjs";

test("aggregateProfile returns null for no events", async () => {
  const result = await aggregateProfile({}, "test-user");
  assert.equal(result, null);
});

test("aggregateProfile returns null when SUPABASE_URL is absent", async () => {
  const result = await aggregateProfile({ DB: {} }, "test-user");
  assert.equal(result, null);
});

test("aggregateProfile returns null when the Supabase secret key is absent", async () => {
  const result = await aggregateProfile({ SUPABASE_URL: "https://example.supabase.co" }, "test-user");
  assert.equal(result, null);
});

test("computeProfileData returns null for empty events", () => {
  assert.equal(computeProfileData([]), null);
  assert.equal(computeProfileData(null), null);
});

test("computeProfileData counts impressions and engagements", () => {
  const now = new Date().toISOString();
  const events = [
    { storyId: 1, eventType: "impression", createdAt: now, topics: '["ai"]', sourceEndpoint: "front" },
    { storyId: 1, eventType: "impression", createdAt: now, topics: '["ai"]', sourceEndpoint: "front" },
    { storyId: 2, eventType: "vote", createdAt: now, topics: '["webdev"]', sourceEndpoint: "show" },
    { storyId: 3, eventType: "save", createdAt: now, topics: '["rust"]', sourceEndpoint: "best" }
  ];

  const result = computeProfileData(events);

  assert.equal(result.totalImpressions, 2);
  assert.equal(result.totalEngagements, 2);
});

test("computeProfileData weights votes higher than impressions", () => {
  const now = new Date().toISOString();
  const events = [
    { storyId: 1, eventType: "impression", createdAt: now, topics: '["ai"]', sourceEndpoint: "front" },
    { storyId: 2, eventType: "vote", createdAt: now, topics: '["webdev"]', sourceEndpoint: "show" }
  ];

  const result = computeProfileData(events);

  assert.ok(result.topicScores.webdev > result.topicScores.ai,
    `webdev (${result.topicScores.webdev}) should be > ai (${result.topicScores.ai})`);
});

test("computeProfileData normalizes scores to 0-1 range", () => {
  const now = new Date().toISOString();
  const events = [
    { storyId: 1, eventType: "vote", createdAt: now, topics: '["ai"]', sourceEndpoint: "front" },
    { storyId: 2, eventType: "vote", createdAt: now, topics: '["ai"]', sourceEndpoint: "front" },
    { storyId: 3, eventType: "impression", createdAt: now, topics: '["webdev"]', sourceEndpoint: "show" }
  ];

  const result = computeProfileData(events);

  for (const score of Object.values(result.topicScores)) {
    assert.ok(score >= 0 && score <= 1, `Score ${score} should be in [0, 1]`);
  }
});

test("computeProfileData also accepts snake_case fields (Supabase format)", () => {
  const now = new Date().toISOString();
  const events = [
    { story_id: 1, event_type: "vote", created_at: now, topics: ["ai"], source_endpoint: "front" },
    { story_id: 2, event_type: "impression", created_at: now, topics: ["webdev"], source_endpoint: "show" }
  ];

  const result = computeProfileData(events);

  assert.ok(result.topicScores.ai > result.topicScores.webdev);
});
