import test from "node:test";
import assert from "node:assert/strict";

import { shouldFallbackToFirecrawl } from "../src/crawl-provider.mjs";

// ── shouldFallbackToFirecrawl ────────────────────────────────────────

test("shouldFallbackToFirecrawl returns true for timeout failures", () => {
  assert.equal(shouldFallbackToFirecrawl({ success: false, failureKind: "timeout" }), true);
});

test("shouldFallbackToFirecrawl returns true for no_content failures", () => {
  assert.equal(shouldFallbackToFirecrawl({ success: false, failureKind: "no_content" }), true);
});

test("shouldFallbackToFirecrawl returns true for http_error failures", () => {
  assert.equal(shouldFallbackToFirecrawl({ success: false, failureKind: "http_error" }), true);
});

test("shouldFallbackToFirecrawl returns true for robots_blocked failures", () => {
  assert.equal(shouldFallbackToFirecrawl({ success: false, failureKind: "robots_blocked" }), true);
});

test("shouldFallbackToFirecrawl returns true for unknown failures", () => {
  assert.equal(shouldFallbackToFirecrawl({ success: false, failureKind: "unknown" }), true);
});

test("shouldFallbackToFirecrawl returns true for null result", () => {
  assert.equal(shouldFallbackToFirecrawl(null), true);
});

test("shouldFallbackToFirecrawl returns false for permanent failures", () => {
  assert.equal(shouldFallbackToFirecrawl({ success: false, failureKind: "permanent" }), false);
});

test("shouldFallbackToFirecrawl returns false for config_error failures", () => {
  assert.equal(shouldFallbackToFirecrawl({ success: false, failureKind: "config_error" }), false);
});

test("shouldFallbackToFirecrawl returns false for successful results", () => {
  assert.equal(shouldFallbackToFirecrawl({ success: true, failureKind: null }), false);
});
