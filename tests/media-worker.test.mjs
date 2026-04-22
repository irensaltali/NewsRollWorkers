import test from "node:test";
import assert from "node:assert/strict";

import { buildArticleMetadataJsonOptions, buildCrawlRequest, crawlUrl, normalizeArticleMetadata, readCrawlMarkdown } from "../src/browser-rendering.mjs";
import mediaWorker from "../workers/processor/index.mjs";
import { buildHeadlineRequest } from "../src/summary.mjs";

test("media worker responds to root fetch requests", async () => {
  const response = await mediaWorker.fetch(new Request("https://example.com/"), {
    ENVIRONMENT: "staging"
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    service: "newsroll-processor",
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

  assert.equal(request.model, "gpt-5.4-mini-2026-03-17");
  assert.equal(request.max_completion_tokens, 80);
  assert.equal("max_output_tokens" in request, false);
  assert.equal(request.messages[1].content.includes("Launch post"), true);
});

test("crawl request uses Cloudflare crawl endpoint parameters", () => {
  const request = buildCrawlRequest("https://example.com/article");

  assert.equal(request.url, "https://example.com/article");
  assert.equal(request.limit, 1);
  assert.equal(request.depth, 1);
  assert.deepEqual(request.crawlPurposes, ["ai-input"]);
  assert.deepEqual(request.formats, ["json", "markdown"]);
  assert.equal(request.jsonOptions?.prompt?.includes("Extract structured article data"), true);
  assert.equal(request.jsonOptions?.response_format?.json_schema?.name, "article_metadata");
});

test("crawl request accepts a caller-provided limit when valid", () => {
  const request = buildCrawlRequest("https://example.com/article", { limit: 3, jsonOptions: null });

  assert.equal(request.url, "https://example.com/article");
  assert.equal(request.limit, 3);
  assert.equal(request.depth, 1);
  assert.deepEqual(request.crawlPurposes, ["ai-input"]);
  assert.deepEqual(request.formats, ["markdown"]);
  assert.equal("jsonOptions" in request, false);
});

test("article metadata json options use the expected schema contract", () => {
  const jsonOptions = buildArticleMetadataJsonOptions();

  assert.equal(jsonOptions.response_format.type, "json_schema");
  assert.equal(jsonOptions.response_format.json_schema.name, "article_metadata");
  assert.equal(jsonOptions.response_format.json_schema.schema.additionalProperties, false);
  assert.deepEqual(
    jsonOptions.response_format.json_schema.schema.required,
    ["headline", "language", "summary", "topics"]
  );
});

test("normalizeArticleMetadata trims and normalizes crawl metadata", () => {
  // title accepted from parsed HTML metadata (Firecrawl og:title / <title>);
  // AI extraction path won't populate it because it's not in the schema.
  assert.deepEqual(normalizeArticleMetadata({
    title: "  Example Title  ",
    headline: "  Two sentence curiosity teaser.  ",
    language: " EN ",
    summary: "  Summary body.  "
  }), {
    title: "Example Title",
    headline: "Two sentence curiosity teaser.",
    language: "en",
    summary: "Summary body.",
    topics: null
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
              json: {
                headline: "Crawled hook.",
                language: "en",
                summary: "Crawled summary."
              },
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
  assert.deepEqual(result.metadata, {
    title: null,
    headline: "Crawled hook.",
    language: "en",
    summary: "Crawled summary.",
    topics: null
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.method, "POST");
  assert.match(calls[0].url, /accounts\/account-123\/browser-rendering\/crawl$/);
  const requestBody = JSON.parse(calls[0].init.body);
  assert.equal(requestBody.url, "https://example.com/article");
  assert.equal(requestBody.limit, 1);
  assert.equal(requestBody.depth, 1);
  assert.deepEqual(requestBody.crawlPurposes, ["ai-input"]);
  assert.deepEqual(requestBody.formats, ["json", "markdown"]);
  assert.equal(requestBody.jsonOptions?.response_format?.json_schema?.name, "article_metadata");
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

test("media worker serves template stats endpoint returns 200 with empty stats when no DB", async () => {
  const response = await mediaWorker.fetch(
    new Request("https://example.com/stats/templates?days=7"),
    { ENVIRONMENT: "staging" }
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.stats));
});
