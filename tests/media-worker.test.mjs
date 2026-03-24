import test from "node:test";
import assert from "node:assert/strict";

import { buildCrawlRequest, crawlUrl, readCrawlMarkdown } from "../src/browser-rendering.mjs";
import mediaWorker from "../workers/media/index.mjs";
import { buildHeadlineRequest } from "../src/summary.mjs";

test("media worker responds to root fetch requests", async () => {
  const response = await mediaWorker.fetch(new Request("https://example.com/"), {
    ENVIRONMENT: "staging"
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    service: "newsroll-media",
    environment: "staging"
  });
});

test("media worker returns 404 for unknown paths", async () => {
  const response = await mediaWorker.fetch(new Request("https://example.com/unknown"), {
    ENVIRONMENT: "staging"
  });

  assert.equal(response.status, 404);
});

test("headline request uses chat completions token field", async () => {
  const request = await buildHeadlineRequest("Launch post", "Some extracted article text.");

  assert.equal(request.model, "o4-mini");
  assert.equal(request.max_completion_tokens, 150);
  assert.equal("max_output_tokens" in request, false);
  assert.equal(request.messages[1].content.includes("Launch post"), true);
});

test("crawl request uses Cloudflare crawl endpoint parameters", () => {
  assert.deepEqual(buildCrawlRequest("https://example.com/article"), {
    url: "https://example.com/article",
    limit: 1,
    crawlPurposes: ["ai-input"],
    formats: ["markdown"],
  });
});

test("crawl request accepts a caller-provided limit when valid", () => {
  assert.deepEqual(buildCrawlRequest("https://example.com/article", { limit: 3 }), {
    url: "https://example.com/article",
    limit: 3,
    crawlPurposes: ["ai-input"],
    formats: ["markdown"],
  });
});

test("readCrawlMarkdown returns markdown from completed crawl records", () => {
  const result = readCrawlMarkdown({
    records: [
      {
        url: "https://example.com/article",
        status: "completed",
        markdown: "# Example\n\nHello world",
        metadata: { status: 200 }
      }
    ]
  }, "https://example.com/article");

  assert.equal(result.error, null);
  assert.equal(result.markdown, "# Example\n\nHello world");
});

test("readCrawlMarkdown prefers the article section over pre-article site chrome", () => {
  const result = readCrawlMarkdown({
    records: [
      {
        url: "https://heatmap.news/story",
        status: "completed",
        metadata: {
          status: 200,
          title: "Why Gas in California Is Almost $6 a Gallon - Heatmap News"
        },
        markdown: [
          "* [Home](/)",
          "* [Energy](https://heatmap.news/energy)",
          "",
          "Login",
          "",
          "# Why Gas in California Is Almost $6 a Gallon — and Could Go Higher",
          "",
          "War with Iran adds to a long list of factors making California gas hella expensive.",
          "",
          "California’s gasoline market is a world all its own.",
          "",
          "Keep reading...Show less",
          "",
          "Footer"
        ].join("\n")
      }
    ]
  }, "https://heatmap.news/story");

  assert.equal(result.error, null);
  assert.equal(
    result.markdown,
    [
      "# Why Gas in California Is Almost $6 a Gallon — and Could Go Higher",
      "",
      "War with Iran adds to a long list of factors making California gas hella expensive.",
      "",
      "California’s gasoline market is a world all its own."
    ].join("\n")
  );
});

test("crawlUrl submits and polls the Cloudflare crawl API", async (t) => {
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });

    if (url.endsWith("/browser-rendering/crawl")) {
      return Response.json({
        success: true,
        result: "job-123"
      });
    }

    if (url.includes("/browser-rendering/crawl/job-123?limit=1")) {
      return Response.json({
        success: true,
        result: {
          id: "job-123",
          status: "completed",
          records: [
            {
              url: "https://example.com/article",
              status: "completed",
              markdown: "# Crawled\n\nStory body",
              metadata: { status: 200 }
            }
          ]
        }
      });
    }

    throw new Error(`Unexpected fetch call: ${url}`);
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await crawlUrl({
    CLOUDFLARE_ACCOUNT_ID: "account-123",
    CLOUDFLARE_API_TOKEN: "token-123"
  }, "https://example.com/article");

  assert.equal(result.success, true);
  assert.equal(result.markdown, "# Crawled\n\nStory body");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.method, "POST");
  assert.match(calls[0].url, /accounts\/account-123\/browser-rendering\/crawl$/);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    url: "https://example.com/article",
    limit: 1,
    crawlPurposes: ["ai-input"],
    formats: ["markdown"],
  });
  assert.match(calls[1].url, /accounts\/account-123\/browser-rendering\/crawl\/job-123\?limit=1$/);
});

test("crawlUrl archives raw crawl json to R2 when markdown is truncated", async (t) => {
  const originalFetch = globalThis.fetch;
  const puts = [];
  const longMarkdown = "A".repeat(17000);

  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/browser-rendering/crawl")) {
      return Response.json({
        success: true,
        result: "job-archive-1"
      });
    }

    if (url.includes("/browser-rendering/crawl/job-archive-1?limit=1")) {
      return Response.json({
        success: true,
        result: {
          id: "job-archive-1",
          status: "completed",
          records: [
            {
              url: "https://example.com/article",
              status: "completed",
              markdown: longMarkdown,
              metadata: { status: 200 }
            }
          ]
        }
      });
    }

    throw new Error(`Unexpected fetch call: ${url}`);
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await crawlUrl({
    CLOUDFLARE_ACCOUNT_ID: "account-123",
    CLOUDFLARE_API_TOKEN: "token-123",
    MEDIA_BUCKET: {
      async put(key, value, options) {
        puts.push({ key, value, options });
      }
    }
  }, "https://example.com/article", { storyId: 42 });

  assert.equal(result.success, true);
  assert.equal(result.markdown?.length, 16000);
  assert.match(result.rawJsonKey ?? "", /^crawl\/raw\/42\/[a-f0-9]+\.json$/);
  assert.equal(puts.length, 1);
  assert.equal(puts[0].key, result.rawJsonKey);
  assert.equal(puts[0].options?.httpMetadata?.contentType, "application/json");
  assert.match(String(puts[0].value), /job-archive-1/);
});

test("crawlUrl fails fast when Cloudflare crawl config is missing", async (t) => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;

  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("fetch should not be called without crawl config");
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await crawlUrl({
    CLOUDFLARE_API_TOKEN: "token-123"
  }, "https://example.com/article");

  assert.equal(fetchCalled, false);
  assert.equal(result.success, false);
  assert.equal(result.markdown, null);
  assert.match(result.error ?? "", /Missing Cloudflare crawl configuration: CLOUDFLARE_ACCOUNT_ID/);
});

test("media worker serves template stats endpoint", async () => {
  const mockDb = {
    prepare(sql) {
      return {
        bind() {
          return {
            async all() {
              return {
                results: [
                  {
                    templateId: 1,
                    templateName: "editorial_v1",
                    totalGenerated: 50,
                    succeeded: 45,
                    failed: 5,
                    deadLettered: 0,
                    totalEngagements: 120,
                    totalImpressions: 1000,
                    engagementRate: 0.12
                  }
                ]
              };
            }
          };
        }
      };
    }
  };

  const response = await mediaWorker.fetch(
    new Request("https://example.com/stats/templates?days=7"),
    { ENVIRONMENT: "staging", DB: mockDb }
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.stats.length, 1);
  assert.equal(body.stats[0].templateName, "editorial_v1");
  assert.equal(body.stats[0].engagementRate, 0.12);
});

test("media worker template stats defaults to 30 days", async () => {
  let boundDays = null;
  const mockDb = {
    prepare() {
      return {
        bind(days) {
          boundDays = days;
          return {
            async all() { return { results: [] }; }
          };
        }
      };
    }
  };

  await mediaWorker.fetch(
    new Request("https://example.com/stats/templates"),
    { ENVIRONMENT: "staging", DB: mockDb }
  );

  assert.equal(boundDays, 30);
});
