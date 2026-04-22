import test from "node:test";
import assert from "node:assert/strict";

import {
  nextPollDelaySeconds,
  crawlDeadlineFor,
  descriptionIsSufficient,
  descriptionIsUsableFallback,
  __private
} from "../src/crawl-scheduler.mjs";

// ── nextPollDelaySeconds ─────────────────────────────────────────────

test("nextPollDelaySeconds follows the back-weighted schedule", () => {
  const schedule = __private.POLL_SCHEDULE_SECONDS;
  for (let i = 0; i < schedule.length; i += 1) {
    assert.equal(nextPollDelaySeconds(i), schedule[i]);
  }
});

test("nextPollDelaySeconds falls back to the tail default past the schedule", () => {
  const length = __private.POLL_SCHEDULE_SECONDS.length;
  assert.equal(nextPollDelaySeconds(length), 300);
  assert.equal(nextPollDelaySeconds(length + 10), 300);
});

test("nextPollDelaySeconds treats negative or non-finite counts as first poll", () => {
  assert.equal(nextPollDelaySeconds(-1), __private.POLL_SCHEDULE_SECONDS[0]);
  assert.equal(nextPollDelaySeconds(Number.NaN), __private.POLL_SCHEDULE_SECONDS[0]);
  assert.equal(nextPollDelaySeconds(undefined), __private.POLL_SCHEDULE_SECONDS[0]);
});

// ── crawlDeadlineFor ─────────────────────────────────────────────────

test("crawlDeadlineFor uses the Cloudflare deadline by default", () => {
  const now = new Date("2026-04-21T12:00:00Z");
  const deadline = crawlDeadlineFor("cloudflare", now);
  assert.equal(deadline.getTime() - now.getTime(), __private.CLOUDFLARE_DEADLINE_MS);
});

test("crawlDeadlineFor extends the deadline for Firecrawl", () => {
  const now = new Date("2026-04-21T12:00:00Z");
  const deadline = crawlDeadlineFor("firecrawl", now);
  assert.equal(deadline.getTime() - now.getTime(), __private.FIRECRAWL_DEADLINE_MS);
});

test("crawlDeadlineFor accepts a timestamp number as now", () => {
  const nowMs = Date.parse("2026-04-21T12:00:00Z");
  const deadline = crawlDeadlineFor("cloudflare", nowMs);
  assert.equal(deadline.getTime() - nowMs, __private.CLOUDFLARE_DEADLINE_MS);
});

// ── descriptionIsSufficient ──────────────────────────────────────────

test("descriptionIsSufficient accepts long, un-truncated descriptions", () => {
  const text = "Full article body sentence. ".repeat(40); // ≈ 1120 chars
  assert.equal(descriptionIsSufficient({ description: text }), true);
});

test("descriptionIsSufficient rejects descriptions shorter than the min length", () => {
  const text = "Short preview body.".repeat(10); // ≈ 190 chars
  assert.equal(descriptionIsSufficient({ description: text }), false);
});

test("descriptionIsSufficient rejects descriptions ending with truncation markers", () => {
  const long = "Full article body sentence. ".repeat(40);
  assert.equal(descriptionIsSufficient({ description: `${long} Click to read` }), false);
  assert.equal(descriptionIsSufficient({ description: `${long} Read more` }), false);
  assert.equal(descriptionIsSufficient({ description: `${long} Continue reading` }), false);
  assert.equal(descriptionIsSufficient({ description: `${long}...` }), false);
  assert.equal(descriptionIsSufficient({ description: `${long}…` }), false);
  assert.equal(descriptionIsSufficient({ description: `${long} [+]` }), false);
});

test("descriptionIsSufficient handles missing or non-string descriptions", () => {
  assert.equal(descriptionIsSufficient({}), false);
  assert.equal(descriptionIsSufficient({ description: null }), false);
  assert.equal(descriptionIsSufficient(null), false);
});

// ── descriptionIsUsableFallback ──────────────────────────────────────

test("descriptionIsUsableFallback accepts descriptions above the fallback threshold", () => {
  const text = "A".repeat(__private.MIN_FALLBACK_DESCRIPTION_LENGTH);
  assert.equal(descriptionIsUsableFallback({ description: text }), true);
});

test("descriptionIsUsableFallback rejects descriptions below the fallback threshold", () => {
  const text = "A".repeat(__private.MIN_FALLBACK_DESCRIPTION_LENGTH - 1);
  assert.equal(descriptionIsUsableFallback({ description: text }), false);
});

test("descriptionIsUsableFallback handles missing descriptions", () => {
  assert.equal(descriptionIsUsableFallback({}), false);
  assert.equal(descriptionIsUsableFallback(null), false);
});
