import test from "node:test";
import assert from "node:assert/strict";

import {
  shouldFallbackToFirecrawl,
  submitCrawl,
  submitCrawlWithProviderFallback,
  checkCrawl,
  CRAWL_PROVIDERS
} from "../src/crawl-provider.mjs";

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

// ── submitCrawl dispatcher ───────────────────────────────────────────

test("submitCrawl routes Cloudflare provider to browser-rendering API", async () => {
  const originalFetch = globalThis.fetch;
  let seenUrl = null;
  try {
    globalThis.fetch = async (url) => {
      seenUrl = String(url);
      return Response.json({ success: true, result: "cf-job-abc" });
    };

    const env = { CLOUDFLARE_ACCOUNT_ID: "acc-1", CLOUDFLARE_API_TOKEN: "token-1" };
    const result = await submitCrawl(env, CRAWL_PROVIDERS.CLOUDFLARE, "https://example.com");

    assert.ok(seenUrl.includes("browser-rendering/crawl"), `expected CF crawl endpoint, got ${seenUrl}`);
    assert.equal(result.success, true);
    assert.equal(result.jobId, "cf-job-abc");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("submitCrawl routes Firecrawl provider to the v2 batch endpoint", async () => {
  const originalFetch = globalThis.fetch;
  let seenUrl = null;
  try {
    globalThis.fetch = async (url) => {
      seenUrl = String(url);
      return Response.json({ success: true, id: "fc-job-xyz" });
    };

    const env = { FIRECRAWL_API_KEYS: "fc-test" };
    const result = await submitCrawl(env, CRAWL_PROVIDERS.FIRECRAWL, "https://example.com");

    assert.equal(seenUrl, "https://api.firecrawl.dev/v2/batch/scrape");
    assert.equal(result.success, true);
    assert.equal(result.jobId, "fc-job-xyz");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("submitCrawl rejects unknown providers with config_error", async () => {
  const result = await submitCrawl({}, "mystery", "https://example.com");
  assert.equal(result.success, false);
  assert.equal(result.failureKind, "config_error");
  assert.equal(result.jobId, null);
});

// ── checkCrawl dispatcher ────────────────────────────────────────────

test("checkCrawl routes Firecrawl to /v2/batch/scrape/{id}", async () => {
  const originalFetch = globalThis.fetch;
  let seenUrl = null;
  try {
    globalThis.fetch = async (url) => {
      seenUrl = String(url);
      return Response.json({ status: "scraping" });
    };

    const env = { FIRECRAWL_API_KEYS: "fc-test" };
    const result = await checkCrawl(env, CRAWL_PROVIDERS.FIRECRAWL, "fc-job-xyz");

    assert.equal(seenUrl, "https://api.firecrawl.dev/v2/batch/scrape/fc-job-xyz");
    assert.equal(result.status, "running");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("checkCrawl rejects unknown providers with config_error", async () => {
  const result = await checkCrawl({}, "mystery", "job-id");
  assert.equal(result.status, "failed");
  assert.equal(result.failureKind, "config_error");
});

// ── submitCrawlWithProviderFallback ──────────────────────────────────

test("submitCrawlWithProviderFallback returns CF result on success", async () => {
  const originalFetch = globalThis.fetch;
  let cfHits = 0;
  try {
    globalThis.fetch = async (url) => {
      if (String(url).includes("browser-rendering/crawl")) {
        cfHits += 1;
        return Response.json({ success: true, result: "cf-job" });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    const env = { CLOUDFLARE_ACCOUNT_ID: "acc", CLOUDFLARE_API_TOKEN: "tok" };
    const result = await submitCrawlWithProviderFallback(env, "https://example.com");

    assert.equal(result.success, true);
    assert.equal(result.provider, CRAWL_PROVIDERS.CLOUDFLARE);
    assert.equal(result.jobId, "cf-job");
    assert.equal(cfHits, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("submitCrawlWithProviderFallback falls back to Firecrawl when CF fails and FC is configured", async () => {
  const originalFetch = globalThis.fetch;
  let cfHits = 0;
  let fcHits = 0;
  try {
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes("browser-rendering/crawl")) {
        cfHits += 1;
        return new Response(JSON.stringify({ success: false }), { status: 500 });
      }
      if (u === "https://api.firecrawl.dev/v2/batch/scrape") {
        fcHits += 1;
        return Response.json({ success: true, id: "fc-job" });
      }
      throw new Error(`Unexpected fetch: ${u}`);
    };

    const env = {
      CLOUDFLARE_ACCOUNT_ID: "acc",
      CLOUDFLARE_API_TOKEN: "tok",
      FIRECRAWL_API_KEYS: "fc-key"
    };
    const result = await submitCrawlWithProviderFallback(env, "https://example.com");

    assert.equal(result.success, true);
    assert.equal(result.provider, CRAWL_PROVIDERS.FIRECRAWL);
    assert.equal(result.jobId, "fc-job");
    assert.ok(result.cfError);
    assert.equal(cfHits, 1);
    assert.equal(fcHits, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("submitCrawlWithProviderFallback returns CF failure when Firecrawl is not configured", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ success: false }), { status: 500 });

    const env = { CLOUDFLARE_ACCOUNT_ID: "acc", CLOUDFLARE_API_TOKEN: "tok" };
    const result = await submitCrawlWithProviderFallback(env, "https://example.com");

    assert.equal(result.success, false);
    assert.equal(result.provider, CRAWL_PROVIDERS.CLOUDFLARE);
    assert.ok(result.cfError);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("submitCrawlWithProviderFallback reports failure when both providers fail", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      if (String(url).includes("browser-rendering/crawl")) {
        return new Response(JSON.stringify({ success: false }), { status: 500 });
      }
      if (String(url).includes("api.firecrawl.dev")) {
        return new Response(JSON.stringify({ success: false }), { status: 500 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    const env = {
      CLOUDFLARE_ACCOUNT_ID: "acc",
      CLOUDFLARE_API_TOKEN: "tok",
      FIRECRAWL_API_KEYS: "fc-key"
    };
    const result = await submitCrawlWithProviderFallback(env, "https://example.com");

    assert.equal(result.success, false);
    assert.equal(result.provider, CRAWL_PROVIDERS.FIRECRAWL);
    assert.ok(result.cfError);
    assert.ok(result.error);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
