import test from "node:test";
import assert from "node:assert/strict";

import {
  scoreStory,
  rerank,
  encodeCursor,
  decodeCursor,
  SCORE_WEIGHTS
} from "../src/recommendation.mjs";

const defaultWeights = { ...SCORE_WEIGHTS };

test("scoreStory produces a numeric score", () => {
  const story = {
    topics: '["ai", "startup"]',
    qualityScore: 0.8,
    noveltyScore: 0.9,
    sourceEndpoint: "front",
    engagementCount: 10,
    impressionCount: 100
  };

  const profile = {
    topicScores: { ai: 0.9, webdev: 0.5 },
    endpointScores: { front: 0.8, show: 0.3 }
  };

  const score = scoreStory(story, profile, defaultWeights);
  assert.equal(typeof score, "number");
  assert.ok(score > 0, `Score should be positive, got ${score}`);
});

test("scoreStory favors stories matching user topics", () => {
  const matchingStory = {
    topics: '["ai"]',
    qualityScore: 0.5,
    noveltyScore: 0.5,
    sourceEndpoint: "front",
    engagementCount: 0,
    impressionCount: 0
  };

  const nonMatchingStory = {
    topics: '["gaming"]',
    qualityScore: 0.5,
    noveltyScore: 0.5,
    sourceEndpoint: "front",
    engagementCount: 0,
    impressionCount: 0
  };

  const profile = {
    topicScores: { ai: 1.0 },
    endpointScores: {}
  };

  // Run multiple times to account for exploration randomness
  let matchWins = 0;
  for (let i = 0; i < 20; i++) {
    const matchScore = scoreStory(matchingStory, profile, defaultWeights);
    const nonMatchScore = scoreStory(nonMatchingStory, profile, defaultWeights);
    if (matchScore > nonMatchScore) matchWins++;
  }

  assert.ok(matchWins > 10, `Matching story should win most of the time, won ${matchWins}/20`);
});

test("rerank prevents more than 2 consecutive same endpoints", () => {
  const items = [
    { storyId: 1, sourceEndpoint: "front", topics: '["ai"]', score: 1.0 },
    { storyId: 2, sourceEndpoint: "front", topics: '["webdev"]', score: 0.9 },
    { storyId: 3, sourceEndpoint: "front", topics: '["startup"]', score: 0.8 },
    { storyId: 4, sourceEndpoint: "show", topics: '["rust"]', score: 0.7 },
    { storyId: 5, sourceEndpoint: "front", topics: '["ai"]', score: 0.6 }
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

test("rerank prevents more than 3 consecutive same primary topic", () => {
  const items = [
    { storyId: 1, sourceEndpoint: "front", topics: '["ai"]', score: 1.0 },
    { storyId: 2, sourceEndpoint: "show", topics: '["ai"]', score: 0.9 },
    { storyId: 3, sourceEndpoint: "best", topics: '["ai"]', score: 0.8 },
    { storyId: 4, sourceEndpoint: "new", topics: '["ai"]', score: 0.7 },
    { storyId: 5, sourceEndpoint: "front", topics: '["webdev"]', score: 0.6 }
  ];

  const ranked = rerank(items);

  for (let i = 3; i < ranked.length; i++) {
    const parse = (t) => { try { return JSON.parse(t)[0]; } catch { return null; } };
    const fourSame =
      parse(ranked[i].topics) === parse(ranked[i - 1].topics) &&
      parse(ranked[i - 1].topics) === parse(ranked[i - 2].topics) &&
      parse(ranked[i - 2].topics) === parse(ranked[i - 3].topics);
    assert.ok(!fourSame, `Four consecutive same topics at position ${i}`);
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
