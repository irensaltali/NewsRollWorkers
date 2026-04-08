import test from "node:test";
import assert from "node:assert/strict";

import { computeRSSQualityScore, ingestSource } from "../src/rss-ingest.mjs";

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

test("ingestSource caps queued media jobs by remainingQueueBudget", async () => {
  const originalFetch = global.fetch;
  const queuedMessages = [];
  let reserveCalls = 0;

  global.fetch = async (input) => {
    const url = String(input);

    if (url === "https://techcrunch.com/feed/") {
      return {
        ok: true,
        async text() {
          return [
            `<?xml version="1.0"?><rss><channel>`,
            `<item><guid>abc</guid><link>https://example.com/story-1</link><title>Story 1</title><description>Example 1</description><pubDate>Wed, 02 Apr 2026 00:00:00 GMT</pubDate></item>`,
            `<item><guid>def</guid><link>https://example.com/story-2</link><title>Story 2</title><description>Example 2</description><pubDate>Wed, 02 Apr 2026 00:00:00 GMT</pubDate></item>`,
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
    assert.equal(queuedMessages[0].title, "Story 1");
    assert.equal(reserveCalls, 1);
  } finally {
    global.fetch = originalFetch;
  }
});
