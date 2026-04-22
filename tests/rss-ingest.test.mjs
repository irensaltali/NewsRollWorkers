import test from "node:test";
import assert from "node:assert/strict";

import { computeRSSQualityScore, fetchAndParseRSS, ingestSource } from "../src/rss-ingest.mjs";

test("computeRSSQualityScore accepts camelCase Supabase rows", () => {
  const score = computeRSSQualityScore(
    { publishedAt: new Date().toISOString() },
    { tier: 1, reliabilityScore: 0.9 }
  );

  assert.ok(score > 0.8, `expected a strong score, got ${score}`);
});

test("ingestSource reads feedUrl from camelCase Supabase rows", async () => {
  const originalFetch = global.fetch;
  let requestedUrl = null;

  global.fetch = async (url) => {
    requestedUrl = String(url);
    return {
      ok: true,
      async text() {
        return `<?xml version="1.0"?><rss><channel><item><guid>abc</guid><link>https://example.com/story</link><title>Story</title><description>Example</description><pubDate>Wed, 02 Apr 2026 00:00:00 GMT</pubDate></item></channel></rss>`;
      }
    };
  };

  try {
    const result = await ingestSource({}, {
      id: 16,
      name: "TechCrunch",
      category: "tech",
      feedUrl: "https://techcrunch.com/feed/",
      tier: 2,
      reliabilityScore: 0.75
    });

    assert.equal(requestedUrl, "https://techcrunch.com/feed/");
    assert.equal(result.fetched, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test("fetchAndParseRSS throws on HTML content-type", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
    async text() {
      return "<!doctype html><html><body>Just a moment…</body></html>";
    }
  });

  try {
    await assert.rejects(
      () => fetchAndParseRSS("https://example.com/feed"),
      /non-XML content-type/
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("fetchAndParseRSS warns rss_parse_empty on large body with zero items", async () => {
  const originalFetch = global.fetch;
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (line) => warnings.push(line);

  global.fetch = async () => ({
    ok: true,
    headers: new Headers({ "content-type": "application/xml" }),
    async text() {
      return `<?xml version="1.0"?><rss><channel><title>Empty</title>${"x".repeat(2000)}</channel></rss>`;
    }
  });

  try {
    const items = await fetchAndParseRSS("https://example.com/feed");
    assert.equal(items.length, 0);
    const parsed = warnings.map((w) => JSON.parse(w));
    const event = parsed.find((p) => p.event === "rss_parse_empty");
    assert.ok(event, "expected rss_parse_empty warning");
    assert.equal(event.feedUrl, "https://example.com/feed");
    assert.ok(event.bytes > 1024);
  } finally {
    global.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

test("fetchAndParseRSS stays quiet for small empty feeds", async () => {
  const originalFetch = global.fetch;
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (line) => warnings.push(line);

  global.fetch = async () => ({
    ok: true,
    headers: new Headers({ "content-type": "application/xml" }),
    async text() {
      return `<?xml version="1.0"?><rss><channel></channel></rss>`;
    }
  });

  try {
    const items = await fetchAndParseRSS("https://example.com/feed");
    assert.equal(items.length, 0);
    const parsed = warnings.map((w) => JSON.parse(w));
    assert.equal(parsed.find((p) => p.event === "rss_parse_empty"), undefined);
  } finally {
    global.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

test("ingestSource skips duplicates when insertRSSItem returns false", async () => {
  const originalFetch = global.fetch;
  const queuedMessages = [];
  let reserveCalls = 0;

  global.fetch = async (input) => {
    const url = String(input);

    if (url === "https://techcrunch.com/feed/") {
      return {
        ok: true,
        headers: new Headers({ "content-type": "application/xml" }),
        async text() {
          return [
            `<?xml version="1.0"?><rss><channel>`,
            `<item><guid>dup</guid><link>https://example.com/dup</link><title>Duplicate</title><description>Seen before</description><pubDate>Wed, 02 Apr 2026 00:00:00 GMT</pubDate></item>`,
            `</channel></rss>`
          ].join("");
        }
      };
    }

    if (url.includes("/rest/v1/rss_items")) {
      return new Response(JSON.stringify({
        code: "23505",
        message: "duplicate key value violates unique constraint \"rss_items_source_id_guid_key\""
      }), {
        status: 409,
        headers: { "content-type": "application/json" }
      });
    }

    if (url.includes("/rest/v1/rpc/reserve_media_slot")) {
      reserveCalls += 1;
      return Response.json(true);
    }

    if (url.includes("/rest/v1/")) {
      return Response.json({});
    }

    throw new Error(`Unexpected fetch call: ${url}`);
  };

  try {
    const result = await ingestSource({
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SECRET_KEY: "secret",
      MEDIA_QUEUE: {
        async send(message) {
          queuedMessages.push(message);
        }
      }
    }, {
      id: 16,
      name: "TechCrunch",
      category: "tech",
      feedUrl: "https://techcrunch.com/feed/",
      tier: 2,
      reliabilityScore: 0.75
    });

    assert.equal(result.fetched, 1);
    assert.equal(result.stored, 0);
    assert.equal(result.queued, 0);
    assert.equal(queuedMessages.length, 0);
    assert.equal(reserveCalls, 0, "reserve_media_slot must not be called for duplicates");
  } finally {
    global.fetch = originalFetch;
  }
});

test("ingestSource caps queued media jobs by remainingQueueBudget", async () => {
  const originalFetch = global.fetch;
  const queuedMessages = [];
  let reserveCalls = 0;
  const longDescription = "Full article body sentence. ".repeat(40);

  global.fetch = async (input) => {
    const url = String(input);

    if (url === "https://techcrunch.com/feed/") {
      return {
        ok: true,
        async text() {
          return [
            `<?xml version="1.0"?><rss><channel>`,
            `<item><guid>abc</guid><link>https://example.com/story-1</link><title>Story 1</title><description>${longDescription}</description><pubDate>Wed, 02 Apr 2026 00:00:00 GMT</pubDate></item>`,
            `<item><guid>def</guid><link>https://example.com/story-2</link><title>Story 2</title><description>${longDescription}</description><pubDate>Wed, 02 Apr 2026 00:00:00 GMT</pubDate></item>`,
            `</channel></rss>`
          ].join("");
        }
      };
    }

    if (url.includes("/rest/v1/rpc/reserve_media_slot")) {
      reserveCalls += 1;
      return Response.json(true);
    }

    if (url.includes("/rest/v1/")) {
      return Response.json({});
    }

    throw new Error(`Unexpected fetch call: ${url}`);
  };

  try {
    const result = await ingestSource({
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SECRET_KEY: "secret",
      MEDIA_QUEUE: {
        async send(message) {
          queuedMessages.push(message);
        }
      }
    }, {
      id: 16,
      name: "TechCrunch",
      category: "tech",
      feedUrl: "https://techcrunch.com/feed/",
      tier: 2,
      reliabilityScore: 0.75
    }, {
      remainingQueueBudget: 1
    });

    assert.equal(result.fetched, 2);
    assert.equal(result.queued, 1);
    assert.equal(queuedMessages.length, 1);
    assert.equal(queuedMessages[0].kind, "media_generate");
    assert.equal(queuedMessages[0].title, "Story 1");
    assert.equal(reserveCalls, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

// ── Phase 2: async crawl dispatch ────────────────────────────────────

function rssXmlWithItem({ title = "Story", url = "https://example.com/story", description = "" } = {}) {
  return [
    `<?xml version="1.0"?><rss><channel>`,
    `<item>`,
    `<guid>${url}</guid>`,
    `<link>${url}</link>`,
    `<title>${title}</title>`,
    `<description>${description}</description>`,
    `<pubDate>Wed, 02 Apr 2026 00:00:00 GMT</pubDate>`,
    `</item>`,
    `</channel></rss>`
  ].join("");
}

test("ingestSource sends media_generate when the RSS description is long enough", async () => {
  const originalFetch = global.fetch;
  const queuedMessages = [];
  const longDescription = "Full article body sentence. ".repeat(40);
  const seenUrls = [];

  global.fetch = async (input) => {
    const url = String(input);
    seenUrls.push(url);

    if (url === "https://techcrunch.com/feed/") {
      return {
        ok: true,
        async text() {
          return rssXmlWithItem({
            title: "Long story",
            url: "https://example.com/long",
            description: longDescription
          });
        }
      };
    }

    if (url.includes("/rest/v1/rpc/reserve_media_slot")) {
      return Response.json(true);
    }

    if (url.includes("/rest/v1/")) {
      return Response.json({});
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const env = {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SECRET_KEY: "secret",
      MEDIA_QUEUE: {
        async send(message, opts) {
          queuedMessages.push({ message, opts });
        }
      }
    };

    const result = await ingestSource(env, {
      id: 16,
      name: "TechCrunch",
      category: "tech",
      feedUrl: "https://techcrunch.com/feed/",
      tier: 2,
      reliabilityScore: 0.75
    });

    assert.equal(result.queued, 1);
    assert.equal(queuedMessages.length, 1);
    assert.equal(queuedMessages[0].message.kind, "media_generate");
    assert.equal(queuedMessages[0].message.title, "Long story");
    assert.equal(queuedMessages[0].opts, undefined);

    const submitHit = seenUrls.some((u) => u.includes("browser-rendering/crawl") || u.includes("firecrawl"));
    assert.equal(submitHit, false, "no crawl submit should be issued on the sufficient-description path");
  } finally {
    global.fetch = originalFetch;
  }
});

test("ingestSource submits CF crawl and queues crawl_check when the description is thin", async () => {
  const originalFetch = global.fetch;
  const queuedMessages = [];
  let cfSubmitCount = 0;
  let storyMediaUpsertBody = null;

  global.fetch = async (input, init) => {
    const url = String(input);

    if (url === "https://techcrunch.com/feed/") {
      return {
        ok: true,
        async text() {
          return rssXmlWithItem({
            title: "Thin story",
            url: "https://example.com/thin",
            description: "too short"
          });
        }
      };
    }

    if (url.includes("browser-rendering/crawl")) {
      cfSubmitCount += 1;
      return Response.json({ success: true, result: "cf-job-abc" });
    }

    if (url.includes("/rest/v1/rpc/reserve_media_slot")) {
      return Response.json(true);
    }

    if (url.includes("/rest/v1/story_media")) {
      storyMediaUpsertBody = JSON.parse(init.body);
      return new Response(JSON.stringify([storyMediaUpsertBody]), {
        status: 201,
        headers: { "content-type": "application/json" }
      });
    }

    if (url.includes("/rest/v1/")) {
      return Response.json({});
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const env = {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SECRET_KEY: "secret",
      CLOUDFLARE_ACCOUNT_ID: "acc-1",
      CLOUDFLARE_API_TOKEN: "token-1",
      MEDIA_QUEUE: {
        async send(message, opts) {
          queuedMessages.push({ message, opts });
        }
      }
    };

    const result = await ingestSource(env, {
      id: 16,
      name: "TechCrunch",
      category: "tech",
      feedUrl: "https://techcrunch.com/feed/",
      tier: 2,
      reliabilityScore: 0.75
    });

    assert.equal(result.queued, 1);
    assert.equal(cfSubmitCount, 1);
    assert.equal(queuedMessages.length, 1);
    assert.equal(queuedMessages[0].message.kind, "crawl_check");
    assert.equal(queuedMessages[0].message.url, "https://example.com/thin");
    assert.equal(queuedMessages[0].message.crawlJobId, "cf-job-abc");
    assert.equal(queuedMessages[0].message.crawlProvider, "cloudflare");
    assert.equal(queuedMessages[0].message.crawlAttempts, 0);
    assert.ok(queuedMessages[0].opts?.delaySeconds > 0, "crawl_check should be delayed");

    assert.ok(storyMediaUpsertBody, "upsertCrawlState should have fired");
    assert.equal(storyMediaUpsertBody.crawl_provider, "cloudflare");
    assert.equal(storyMediaUpsertBody.crawl_job_id, "cf-job-abc");
    assert.equal(storyMediaUpsertBody.crawl_poll_count, 0);
    assert.ok(storyMediaUpsertBody.crawl_deadline, "deadline should be stamped");
  } finally {
    global.fetch = originalFetch;
  }
});

test("ingestSource falls back to Firecrawl async submit when CF is misconfigured", async () => {
  const originalFetch = global.fetch;
  const queuedMessages = [];
  let cfSubmitCount = 0;
  let fcSubmitCount = 0;
  let storyMediaUpsertBody = null;

  global.fetch = async (input, init) => {
    const url = String(input);

    if (url === "https://techcrunch.com/feed/") {
      return {
        ok: true,
        async text() {
          return rssXmlWithItem({
            title: "Fallback story",
            url: "https://example.com/fallback",
            description: "short"
          });
        }
      };
    }

    if (url.includes("browser-rendering/crawl")) {
      cfSubmitCount += 1;
      return new Response(JSON.stringify({ success: false, errors: [{ message: "invalid token" }] }), { status: 401 });
    }

    if (url === "https://api.firecrawl.dev/v2/batch/scrape") {
      fcSubmitCount += 1;
      return Response.json({ success: true, id: "fc-job-xyz" });
    }

    if (url.includes("/rest/v1/rpc/reserve_media_slot")) {
      return Response.json(true);
    }

    if (url.includes("/rest/v1/story_media")) {
      storyMediaUpsertBody = JSON.parse(init.body);
      return new Response(JSON.stringify([storyMediaUpsertBody]), {
        status: 201,
        headers: { "content-type": "application/json" }
      });
    }

    if (url.includes("/rest/v1/")) {
      return Response.json({});
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const env = {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SECRET_KEY: "secret",
      CLOUDFLARE_ACCOUNT_ID: "acc-1",
      CLOUDFLARE_API_TOKEN: "bad-token",
      FIRECRAWL_API_KEYS: "fc-key",
      MEDIA_QUEUE: {
        async send(message, opts) {
          queuedMessages.push({ message, opts });
        }
      }
    };

    const result = await ingestSource(env, {
      id: 16,
      name: "TechCrunch",
      category: "tech",
      feedUrl: "https://techcrunch.com/feed/",
      tier: 2,
      reliabilityScore: 0.75
    });

    assert.equal(result.queued, 1);
    assert.equal(cfSubmitCount, 1);
    assert.equal(fcSubmitCount, 1);
    assert.equal(queuedMessages.length, 1);
    assert.equal(queuedMessages[0].message.kind, "crawl_check");
    assert.equal(queuedMessages[0].message.crawlJobId, "fc-job-xyz");
    assert.equal(queuedMessages[0].message.crawlProvider, "firecrawl");
    assert.equal(queuedMessages[0].message.crawlAttempts, 0);

    assert.ok(storyMediaUpsertBody);
    assert.equal(storyMediaUpsertBody.crawl_provider, "firecrawl");
    assert.equal(storyMediaUpsertBody.crawl_job_id, "fc-job-xyz");
  } finally {
    global.fetch = originalFetch;
  }
});

test("ingestSource falls back to media_generate with fallbackReason when crawl submit fails but description is usable", async () => {
  const originalFetch = global.fetch;
  const queuedMessages = [];
  const fallbackDescription = "This article has just enough body. ".repeat(8); // ≈ 280 chars

  global.fetch = async (input) => {
    const url = String(input);

    if (url === "https://techcrunch.com/feed/") {
      return {
        ok: true,
        async text() {
          return rssXmlWithItem({
            title: "Mid story",
            url: "https://example.com/mid",
            description: fallbackDescription
          });
        }
      };
    }

    if (url.includes("browser-rendering/crawl")) {
      return new Response(JSON.stringify({ success: false }), { status: 500 });
    }

    if (url.includes("/rest/v1/rpc/reserve_media_slot")) {
      return Response.json(true);
    }

    if (url.includes("/rest/v1/")) {
      return Response.json({});
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const env = {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SECRET_KEY: "secret",
      CLOUDFLARE_ACCOUNT_ID: "acc-1",
      CLOUDFLARE_API_TOKEN: "token-1",
      MEDIA_QUEUE: {
        async send(message, opts) {
          queuedMessages.push({ message, opts });
        }
      }
    };

    const result = await ingestSource(env, {
      id: 16,
      name: "TechCrunch",
      category: "tech",
      feedUrl: "https://techcrunch.com/feed/",
      tier: 2,
      reliabilityScore: 0.75
    });

    assert.equal(result.queued, 1);
    assert.equal(queuedMessages.length, 1);
    assert.equal(queuedMessages[0].message.kind, "media_generate");
    assert.equal(queuedMessages[0].message.fallbackReason, "crawl_submit_failed");
    assert.equal(queuedMessages[0].opts, undefined);
  } finally {
    global.fetch = originalFetch;
  }
});

test("ingestSource releases the media slot when crawl submit fails and description is too short", async () => {
  const originalFetch = global.fetch;
  const queuedMessages = [];
  let releaseCalls = 0;

  global.fetch = async (input) => {
    const url = String(input);

    if (url === "https://techcrunch.com/feed/") {
      return {
        ok: true,
        async text() {
          return rssXmlWithItem({
            title: "Tiny story",
            url: "https://example.com/tiny",
            description: "tiny"
          });
        }
      };
    }

    if (url.includes("browser-rendering/crawl")) {
      return new Response(JSON.stringify({ success: false }), { status: 500 });
    }

    if (url.includes("/rest/v1/rpc/reserve_media_slot")) {
      return Response.json(true);
    }

    if (url.includes("/rest/v1/story_media") && String(input).includes("status=eq.queued")) {
      releaseCalls += 1;
      return new Response("", { status: 204 });
    }

    if (url.includes("/rest/v1/")) {
      return Response.json({});
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const env = {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SECRET_KEY: "secret",
      CLOUDFLARE_ACCOUNT_ID: "acc-1",
      CLOUDFLARE_API_TOKEN: "token-1",
      MEDIA_QUEUE: {
        async send(message, opts) {
          queuedMessages.push({ message, opts });
        }
      }
    };

    const result = await ingestSource(env, {
      id: 16,
      name: "TechCrunch",
      category: "tech",
      feedUrl: "https://techcrunch.com/feed/",
      tier: 2,
      reliabilityScore: 0.75
    });

    assert.equal(result.queued, 0);
    assert.equal(queuedMessages.length, 0);
    assert.equal(releaseCalls, 1, "slot should be released when nothing is dispatched");
  } finally {
    global.fetch = originalFetch;
  }
});
