import test from "node:test";
import assert from "node:assert/strict";

import {
  computeFreshnessScore,
  scoreStory,
  rerank,
  encodeCursor,
  decodeCursor,
  SCORE_WEIGHTS
} from "../src/recommendation.mjs";

const defaultWeights = { ...SCORE_WEIGHTS };

test("scoreStory produces a numeric score", () => {
  const story = {
    publishedAt: new Date().toISOString(),
    sourceEndpoint: "front",
    engagementCount: 10,
    impressionCount: 100
  };

  const profile = {
    endpointScores: { front: 0.8, show: 0.3 }
  };

  const score = scoreStory(story, profile, defaultWeights);
  assert.equal(typeof score, "number");
  assert.ok(score > 0, `Score should be positive, got ${score}`);
});

test("scoreStory favors stories from preferred endpoints", () => {
  const frontStory = {
    publishedAt: new Date().toISOString(),
    sourceEndpoint: "front",
    engagementCount: 0,
    impressionCount: 0
  };

  const showStory = {
    publishedAt: new Date().toISOString(),
    sourceEndpoint: "show",
    engagementCount: 0,
    impressionCount: 0
  };

  const profile = {
    endpointScores: { front: 1.0, show: 0.0 }
  };

  let preferredWins = 0;
  for (let i = 0; i < 20; i++) {
    const frontScore = scoreStory(frontStory, profile, defaultWeights);
    const showScore = scoreStory(showStory, profile, defaultWeights);
    if (frontScore > showScore) preferredWins++;
  }

  assert.ok(preferredWins > 10, `Preferred endpoint should win most of the time, won ${preferredWins}/20`);
});

test("computeFreshnessScore decays over time", () => {
  const now = Date.now();
  const fresh = computeFreshnessScore(new Date(now).toISOString());
  const old = computeFreshnessScore(new Date(now - 48 * 60 * 60 * 1000).toISOString());

  assert.ok(fresh > old, `fresh (${fresh}) should be > old (${old})`);
});

test("rerank prevents more than 2 consecutive same endpoints", () => {
  const items = [
    { storyId: 1, sourceEndpoint: "front", score: 1.0 },
    { storyId: 2, sourceEndpoint: "front", score: 0.9 },
    { storyId: 3, sourceEndpoint: "front", score: 0.8 },
    { storyId: 4, sourceEndpoint: "show", score: 0.7 },
    { storyId: 5, sourceEndpoint: "front", score: 0.6 }
  ];

  const ranked = rerank(items);

  // Check no more than 2 consecutive same endpoint
  for (let i = 2; i < ranked.length; i++) {
    const threeSame =
      ranked[i].sourceEndpoint === ranked[i - 1].sourceEndpoint &&
      ranked[i - 1].sourceEndpoint === ranked[i - 2].sourceEndpoint;
    assert.ok(!threeSame, `Three consecutive same endpoints at position ${i}`);
  }
});

test("cursor encode/decode round-trip", () => {
  const data = { seen: [1, 2, 3], page: 1 };
  const encoded = encodeCursor(data);
  const decoded = decodeCursor(encoded);
  assert.deepEqual(decoded, data);
});

test("decodeCursor returns null for invalid input", () => {
  assert.equal(decodeCursor(null), null);
  assert.equal(decodeCursor(""), null);
  assert.equal(decodeCursor("not-valid-base64!!!"), null);
});

test("cursor is URL-safe (no + / =)", () => {
  const data = { seen: Array.from({ length: 60 }, (_, i) => i), page: 3 };
  const encoded = encodeCursor(data);
  assert.ok(!encoded.includes("+"), "Should not contain +");
  assert.ok(!encoded.includes("/"), "Should not contain /");
  assert.ok(!encoded.includes("="), "Should not contain =");
});
