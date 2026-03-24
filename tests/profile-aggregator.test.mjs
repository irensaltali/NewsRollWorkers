import test from "node:test";
import assert from "node:assert/strict";

import { aggregateProfile } from "../src/profile-aggregator.mjs";

function createMockDb(events, existingProfile = null) {
  let savedProfile = null;

  return {
    prepare: (sql) => ({
      bind: (...args) => ({
        all: async () => {
          if (sql.includes("user_events")) {
            return { results: events };
          }
          return { results: [] };
        },
        first: async () => existingProfile,
        run: async () => {
          if (sql.includes("INSERT INTO user_profiles")) {
            savedProfile = {
              topicScores: args[1],
              endpointScores: args[2],
              totalImpressions: args[3],
              totalEngagements: args[4]
            };
          }
          return { meta: { changes: 1 } };
        }
      })
    }),
    getSavedProfile: () => savedProfile
  };
}

test("aggregateProfile returns null for no events", async () => {
  const db = createMockDb([]);
  const result = await aggregateProfile({ DB: db }, "test-install");
  assert.equal(result, null);
});

test("aggregateProfile counts impressions and engagements", async () => {
  const now = new Date().toISOString();
  const events = [
    { storyId: 1, eventType: "impression", createdAt: now, topics: '["ai"]', sourceEndpoint: "front" },
    { storyId: 1, eventType: "impression", createdAt: now, topics: '["ai"]', sourceEndpoint: "front" },
    { storyId: 2, eventType: "vote", createdAt: now, topics: '["webdev"]', sourceEndpoint: "show" },
    { storyId: 3, eventType: "save", createdAt: now, topics: '["rust"]', sourceEndpoint: "best" }
  ];

  const db = createMockDb(events);
  const result = await aggregateProfile({ DB: db }, "test-install");

  assert.equal(result.totalImpressions, 2);
  assert.equal(result.totalEngagements, 2);
});

test("aggregateProfile weights votes higher than impressions", async () => {
  const now = new Date().toISOString();
  const events = [
    { storyId: 1, eventType: "impression", createdAt: now, topics: '["ai"]', sourceEndpoint: "front" },
    { storyId: 2, eventType: "vote", createdAt: now, topics: '["webdev"]', sourceEndpoint: "show" }
  ];

  const db = createMockDb(events);
  const result = await aggregateProfile({ DB: db }, "test-install");

  assert.ok(result.topicScores.webdev > result.topicScores.ai,
    `webdev (${result.topicScores.webdev}) should be > ai (${result.topicScores.ai})`);
});

test("aggregateProfile normalizes scores to 0-1 range", async () => {
  const now = new Date().toISOString();
  const events = [
    { storyId: 1, eventType: "vote", createdAt: now, topics: '["ai"]', sourceEndpoint: "front" },
    { storyId: 2, eventType: "vote", createdAt: now, topics: '["ai"]', sourceEndpoint: "front" },
    { storyId: 3, eventType: "impression", createdAt: now, topics: '["webdev"]', sourceEndpoint: "show" }
  ];

  const db = createMockDb(events);
  const result = await aggregateProfile({ DB: db }, "test-install");

  for (const score of Object.values(result.topicScores)) {
    assert.ok(score >= 0 && score <= 1, `Score ${score} should be in [0, 1]`);
  }
});
