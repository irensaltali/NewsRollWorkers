import test from "node:test";
import assert from "node:assert/strict";

import { resolveArticleContent } from "../src/article-content.mjs";

test("resolveArticleContent can skip persisting crawled content", async (t) => {
  let storyContentWrites = 0;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";

    if (url.endsWith("/browser-rendering/crawl")) {
      return Response.json({
        success: true,
        result: "job-article-content-dry-run-1"
      });
    }

    if (url.includes("/browser-rendering/crawl/job-article-content-dry-run-1?limit=1")) {
      return Response.json({
        success: true,
        result: {
          id: "job-article-content-dry-run-1",
          status: "completed",
          records: [
            {
              url: "https://example.com/article-content-dry-run",
              status: "completed",
              markdown: "# Dry Run Crawl\n\nCrawled article body",
              json: {
                title: "Dry Run Crawl Title"
              },
              metadata: { status: 200 }
            }
          ]
        }
      });
    }

    if (url.includes("/rest/v1/story_content") && method === "POST") {
      storyContentWrites += 1;
      return Response.json([]);
    }

    throw new Error(`Unexpected fetch call: ${url} ${method}`);
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await resolveArticleContent({
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SECRET_KEY: "service-role-test",
    CLOUDFLARE_ACCOUNT_ID: "account-123",
    CLOUDFLARE_API_TOKEN: "token-123"
  }, 123, {
    url: "https://example.com/article-content-dry-run"
  }, {
    allowCrawl: true,
    recrawl: true,
    persistCrawlResult: false
  });

  assert.equal(result.sourceKind, "crawl");
  assert.equal(result.title, "Dry Run Crawl Title");
  assert.equal(result.text.includes("Crawled article body"), true);
  assert.equal(storyContentWrites, 0);
});
