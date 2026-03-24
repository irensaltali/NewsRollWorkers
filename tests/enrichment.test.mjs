import test from "node:test";
import assert from "node:assert/strict";

import {
  extractTopicsKeyword,
  computeQualityScore,
  computeNoveltyScore
} from "../src/enrichment.mjs";

test("extractTopicsKeyword detects AI topics", () => {
  const topics = extractTopicsKeyword("GPT-5 Released: A New Era for LLMs", "OpenAI releases its latest model");
  assert.ok(topics.includes("ai"));
});

test("extractTopicsKeyword detects webdev from project description", () => {
  const topics = extractTopicsKeyword("My New Side Project", "A tool for web developers using React");
  assert.ok(topics.includes("webdev"));
});

test("extractTopicsKeyword detects multiple topics", () => {
  const topics = extractTopicsKeyword("Building a React App with PostgreSQL and Docker", "");
  assert.ok(topics.includes("webdev"));
  assert.ok(topics.includes("database"));
  assert.ok(topics.includes("devtools"));
});

test("extractTopicsKeyword detects punctuated language names", () => {
  const topics = extractTopicsKeyword("C++ interop in .NET 10 with C#", "");
  assert.ok(topics.includes("c_cpp"));
  assert.ok(topics.includes("csharp"));
});

test("extractTopicsKeyword falls back to general", () => {
  const topics = extractTopicsKeyword("A Random Thought", "Nothing specific");
  assert.deepEqual(topics, ["general"]);
});

test("computeQualityScore returns value between 0 and 1", () => {
  const score = computeQualityScore({ score: 100, descendants: 50, sourceEndpoint: "front" });
  assert.ok(score >= 0);
  assert.ok(score <= 1);
});

test("computeQualityScore gives higher score to popular stories", () => {
  const highScore = computeQualityScore({ score: 500, descendants: 200, sourceEndpoint: "front" });
  const lowScore = computeQualityScore({ score: 5, descendants: 1, sourceEndpoint: "new" });
  assert.ok(highScore > lowScore);
});

test("computeQualityScore boosts best endpoint", () => {
  const best = computeQualityScore({ score: 100, descendants: 50, sourceEndpoint: "best" });
  const newE = computeQualityScore({ score: 100, descendants: 50, sourceEndpoint: "new" });
  assert.ok(best > newE);
});

test("computeNoveltyScore returns 1.0 for just-published stories", () => {
  const score = computeNoveltyScore(new Date().toISOString());
  assert.ok(score > 0.95);
});

test("computeNoveltyScore decays over 48 hours", () => {
  const now = Date.now();
  const twentyFourHoursAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const fortyEightHoursAgo = new Date(now - 48 * 60 * 60 * 1000).toISOString();

  const recent = computeNoveltyScore(new Date(now).toISOString());
  const mid = computeNoveltyScore(twentyFourHoursAgo);
  const old = computeNoveltyScore(fortyEightHoursAgo);

  assert.ok(recent > mid, `recent (${recent}) should be > mid (${mid})`);
  assert.ok(mid > old, `mid (${mid}) should be > old (${old})`);
  assert.ok(old <= 0.15, `old (${old}) should be near 0.1`);
});

test("computeNoveltyScore returns 0.5 for null input", () => {
  assert.equal(computeNoveltyScore(null), 0.5);
});
