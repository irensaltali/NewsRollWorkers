import test from "node:test";
import assert from "node:assert/strict";

import {
  appendCrawlError,
  clearCrawlState,
  clearRSSItemCrawlFailure,
  getImagePromptOptimizerConfig,
  incrementCrawlPollCount,
  insertRSSItem,
  markRSSItemCrawlFailure,
  resolveImagePromptOptimizerConfig,
  selectCrawlState,
  storeReadableContent,
  storeStoryExplanation,
  storeStorySummary,
  upsertCrawlState
} from "../src/db.mjs";

test("storeReadableContent persists source and feed URLs when provided", async () => {
  const env = {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SECRET_KEY: "service-role-test"
  };

  let storyContentBody = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("/rest/v1/story_content")) {
      storyContentBody = JSON.parse(init.body);
      return new Response(JSON.stringify([storyContentBody]), {
        status: 201,
        headers: { "content-type": "application/json" }
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    await storeReadableContent(env, {
      storyId: 123,
      sourceKind: "rss",
      extractedText: "Seeded RSS description",
      sourceUrl: "https://example.com/source-story",
      feedUrl: "https://example.com/feed.xml",
      updatedAt: "2026-04-02T12:00:00Z"
    });

    assert.deepEqual(storyContentBody, {
      story_id: 123,
      source_kind: "rss",
      extracted_text: "Seeded RSS description",
      source_url: "https://example.com/source-story",
      feed_url: "https://example.com/feed.xml",
      updated_at: "2026-04-02T12:00:00Z"
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("storeStorySummary fills missing source and feed URLs from rss metadata", async () => {
  const env = {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SECRET_KEY: "service-role-test"
  };

  let rssLookupCount = 0;
  let storyContentBody = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("/rest/v1/rss_items")) {
      rssLookupCount += 1;
      return new Response(JSON.stringify({
        story_id: 456,
        url: "https://example.com/original",
        canonical_url: "https://example.com/canonical",
        rss_sources: {
          feed_url: "https://example.com/source-feed.xml"
        }
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (url.includes("/rest/v1/story_content")) {
      storyContentBody = JSON.parse(init.body);
      return new Response(JSON.stringify([storyContentBody]), {
        status: 201,
        headers: { "content-type": "application/json" }
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    await storeStorySummary(env, {
      storyId: 456,
      summary: "• Bullet one",
      updatedAt: "2026-04-02T12:05:00Z"
    });

    assert.equal(rssLookupCount, 1);
    assert.deepEqual(storyContentBody, {
      story_id: 456,
      source_url: "https://example.com/canonical",
      feed_url: "https://example.com/source-feed.xml",
      summary: "• Bullet one",
      updated_at: "2026-04-02T12:05:00Z"
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("storeStoryExplanation persists a formatted explanation snapshot", async () => {
  const env = {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SECRET_KEY: "service-role-test"
  };

  let storyContentBody = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("/rest/v1/story_content")) {
      storyContentBody = JSON.parse(init.body);
      return new Response(JSON.stringify([storyContentBody]), {
        status: 201,
        headers: { "content-type": "application/json" }
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    await storeStoryExplanation(env, {
      storyId: 789,
      sourceUrl: "https://example.com/explain-story",
      feedUrl: "https://example.com/explain-feed.xml",
      explanation: "Overview\n\nWhat happened:\nDetailed explanation body.",
      updatedAt: "2026-04-02T12:10:00Z"
    });

    assert.deepEqual(storyContentBody, {
      story_id: 789,
      source_url: "https://example.com/explain-story",
      feed_url: "https://example.com/explain-feed.xml",
      explanation: "Overview\n\nWhat happened:\nDetailed explanation body.",
      updated_at: "2026-04-02T12:10:00Z"
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("insertRSSItem returns true when Supabase accepts the insert", async () => {
  const env = {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SECRET_KEY: "service-role-test"
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("/rest/v1/rss_items")) {
      return new Response("", { status: 201 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const inserted = await insertRSSItem(env, {
      storyId: 1,
      sourceId: 2,
      guid: "new-guid",
      url: "https://example.com/a",
      canonicalUrl: "https://example.com/a",
      title: "Title",
      description: "Desc",
      author: null,
      publishedAt: "2026-04-02T00:00:00Z"
    });
    assert.equal(inserted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("insertRSSItem returns false on 23505 unique-violation duplicates", async () => {
  const env = {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SECRET_KEY: "service-role-test"
  };

  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (line) => warnings.push(line);

  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("/rest/v1/rss_items")) {
      return new Response(JSON.stringify({
        code: "23505",
        message: "duplicate key value violates unique constraint \"rss_items_source_id_guid_key\""
      }), {
        status: 409,
        headers: { "content-type": "application/json" }
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const inserted = await insertRSSItem(env, {
      storyId: 1,
      sourceId: 2,
      guid: "existing-guid",
      url: "https://example.com/a",
      canonicalUrl: "https://example.com/a",
      title: "Title",
      description: null,
      author: null,
      publishedAt: null
    });
    assert.equal(inserted, false);
    const loggedFail = warnings
      .map((w) => JSON.parse(w))
      .find((p) => p.event === "rss_item_insert_fail");
    assert.equal(loggedFail, undefined, "duplicates should not log rss_item_insert_fail");
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

test("insertRSSItem warns and returns false on unexpected errors", async () => {
  const env = {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SECRET_KEY: "service-role-test"
  };

  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (line) => warnings.push(line);

  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("/rest/v1/rss_items")) {
      return new Response(JSON.stringify({
        code: "42P01",
        message: "relation \"rss_items\" does not exist"
      }), {
        status: 500,
        headers: { "content-type": "application/json" }
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const inserted = await insertRSSItem(env, {
      storyId: 1,
      sourceId: 2,
      guid: "boom",
      url: "https://example.com/a",
      canonicalUrl: "https://example.com/a",
      title: "Title",
      description: null,
      author: null,
      publishedAt: null
    });
    assert.equal(inserted, false);
    const loggedFail = warnings
      .map((w) => JSON.parse(w))
      .find((p) => p.event === "rss_item_insert_fail");
    assert.ok(loggedFail, "expected rss_item_insert_fail warning for unexpected errors");
    assert.equal(loggedFail.code, "42P01");
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

test("markRSSItemCrawlFailure persists failure details on rss_items", async () => {
  const env = {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SECRET_KEY: "service-role-test"
  };

  let rssItemsBody = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("/rest/v1/rss_items")) {
      rssItemsBody = JSON.parse(init.body);
      return new Response(JSON.stringify([rssItemsBody]), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    await markRSSItemCrawlFailure(env, 321, "no_metadata");

    assert.equal(rssItemsBody.crawl_failed, true);
    assert.equal(rssItemsBody.crawl_failure_reason, "no_metadata");
    assert.match(rssItemsBody.crawl_failed_at, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("clearRSSItemCrawlFailure resets failure details on rss_items", async () => {
  const env = {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SECRET_KEY: "service-role-test"
  };

  let rssItemsBody = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("/rest/v1/rss_items")) {
      rssItemsBody = JSON.parse(init.body);
      return new Response(JSON.stringify([rssItemsBody]), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    await clearRSSItemCrawlFailure(env, 321);

    assert.deepEqual(rssItemsBody, {
      crawl_failed: false,
      crawl_failure_reason: null,
      crawl_failed_at: null
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getImagePromptOptimizerConfig selects an explicit config id when provided", async () => {
  const env = {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SECRET_KEY: "service-role-test"
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("/rest/v1/image_prompt_optimizer_configs")) {
      return new Response(JSON.stringify({
        id: 42,
        key: "campaign_optimizer",
        version: "v2",
        name: "Campaign Optimizer",
        provider: "openai",
        model: "gpt-5.4-mini-2026-03-17",
        max_completion_tokens: 400,
        system_prompt: "system",
        user_prompt_template: "template",
        settings: {},
        active: false
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const config = await getImagePromptOptimizerConfig(env, { id: 42 });
    assert.equal(config.id, 42);
    assert.equal(config.key, "campaign_optimizer");
    assert.equal(config.version, "v2");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getImagePromptOptimizerConfig can choose a random active config", async () => {
  const env = {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SECRET_KEY: "service-role-test"
  };

  const originalFetch = globalThis.fetch;
  const originalRandom = Math.random;
  Math.random = () => 0.75;

  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("/rest/v1/image_prompt_optimizer_configs")) {
      return new Response(JSON.stringify([
        {
          id: 1,
          key: "optimizer_a",
          version: "v1",
          name: "Optimizer A",
          provider: "openai",
          model: "gpt-5.4-mini-2026-03-17",
          max_completion_tokens: 400,
          system_prompt: "system-a",
          user_prompt_template: "template-a",
          settings: {},
          active: true
        },
        {
          id: 2,
          key: "optimizer_b",
          version: "v1",
          name: "Optimizer B",
          provider: "openai",
          model: "gpt-5.4-mini-2026-03-17",
          max_completion_tokens: 400,
          system_prompt: "system-b",
          user_prompt_template: "template-b",
          settings: {},
          active: true
        }
      ]), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const config = await getImagePromptOptimizerConfig(env, {
      randomActive: true,
      key: null
    });
    assert.equal(config.id, 2);
    assert.equal(config.key, "optimizer_b");
  } finally {
    globalThis.fetch = originalFetch;
    Math.random = originalRandom;
  }
});

// ── Crawl state helpers ──────────────────────────────────────────────

test("selectCrawlState returns null when SUPABASE_URL is absent", async () => {
  assert.equal(await selectCrawlState({}, 123), null);
});

test("selectCrawlState maps snake_case row into camelCase crawl state", async () => {
  const env = {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SECRET_KEY: "service-role-test"
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("/rest/v1/story_media")) {
      return new Response(JSON.stringify({
        story_id: 123,
        status: "queued",
        crawl_provider: "firecrawl",
        crawl_job_id: "fc-job-xyz",
        crawl_submitted_at: "2026-04-21T12:00:00Z",
        crawl_poll_count: 3,
        crawl_deadline: "2026-04-21T12:10:00Z",
        crawl_errors: [{ provider: "cloudflare", error: "timeout", at: "2026-04-21T12:01:00Z" }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const state = await selectCrawlState(env, 123);
    assert.deepEqual(state, {
      storyId: 123,
      status: "queued",
      crawlProvider: "firecrawl",
      crawlJobId: "fc-job-xyz",
      crawlSubmittedAt: "2026-04-21T12:00:00Z",
      crawlPollCount: 3,
      crawlDeadline: "2026-04-21T12:10:00Z",
      crawlErrors: [{ provider: "cloudflare", error: "timeout", at: "2026-04-21T12:01:00Z" }]
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("upsertCrawlState posts a queued row with crawl metadata", async () => {
  const env = {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SECRET_KEY: "service-role-test"
  };

  let storyMediaBody = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("/rest/v1/story_media")) {
      storyMediaBody = JSON.parse(init.body);
      return new Response(JSON.stringify([storyMediaBody]), {
        status: 201,
        headers: { "content-type": "application/json" }
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    await upsertCrawlState(env, {
      storyId: 123,
      provider: "cloudflare",
      jobId: "cf-job-abc",
      submittedAt: "2026-04-21T12:00:00Z",
      deadline: "2026-04-21T12:08:00Z"
    });

    assert.equal(storyMediaBody.story_id, 123);
    assert.equal(storyMediaBody.status, "queued");
    assert.equal(storyMediaBody.attempts, 0);
    assert.equal(storyMediaBody.crawl_provider, "cloudflare");
    assert.equal(storyMediaBody.crawl_job_id, "cf-job-abc");
    assert.equal(storyMediaBody.crawl_submitted_at, "2026-04-21T12:00:00Z");
    assert.equal(storyMediaBody.crawl_deadline, "2026-04-21T12:08:00Z");
    assert.equal(storyMediaBody.crawl_poll_count, 0);
    assert.match(storyMediaBody.updated_at, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("incrementCrawlPollCount calls the increment RPC and returns the new count", async () => {
  const env = {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SECRET_KEY: "service-role-test"
  };

  let rpcBody = null;
  let rpcUrl = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("/rest/v1/rpc/increment_crawl_poll_count")) {
      rpcUrl = url;
      rpcBody = JSON.parse(init.body);
      return new Response(JSON.stringify(4), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const next = await incrementCrawlPollCount(env, 123);
    assert.equal(next, 4);
    assert.ok(rpcUrl);
    assert.deepEqual(rpcBody, { p_story_id: 123 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("appendCrawlError calls the append RPC with a structured entry", async () => {
  const env = {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SECRET_KEY: "service-role-test"
  };

  let rpcBody = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("/rest/v1/rpc/append_crawl_error")) {
      rpcBody = JSON.parse(init.body);
      return new Response("", { status: 204 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    await appendCrawlError(env, 456, { provider: "cloudflare", error: "HTTP 503" });
    assert.equal(rpcBody.p_story_id, 456);
    assert.equal(rpcBody.p_entry.provider, "cloudflare");
    assert.equal(rpcBody.p_entry.error, "HTTP 503");
    assert.match(rpcBody.p_entry.at, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("clearCrawlState nulls crawl columns on the story_media row", async () => {
  const env = {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SECRET_KEY: "service-role-test"
  };

  let patchBody = null;
  let patchUrl = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("/rest/v1/story_media")) {
      patchUrl = url;
      patchBody = JSON.parse(init.body);
      return new Response(JSON.stringify([patchBody]), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    await clearCrawlState(env, 789);
    assert.ok(patchUrl.includes("story_id=eq.789"));
    assert.equal(patchBody.crawl_provider, null);
    assert.equal(patchBody.crawl_job_id, null);
    assert.equal(patchBody.crawl_submitted_at, null);
    assert.equal(patchBody.crawl_deadline, null);
    assert.equal(patchBody.crawl_poll_count, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("resolveImagePromptOptimizerConfig chooses a topic-matched config and exposes routing metadata", async () => {
  const env = {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SECRET_KEY: "service-role-test"
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("/rest/v1/image_prompt_optimizer_configs")) {
      return new Response(JSON.stringify([
        {
          id: 11,
          key: "news_image_prompt_optimizer",
          version: "v1.1-a",
          name: "Variant A",
          optimizer_provider: "openai",
          optimizer_model: "gpt-5.4-mini-2026-03-17",
          generation_provider: "fal",
          generation_model: "fal-ai/flux-2/turbo",
          max_completion_tokens: 500,
          system_prompt: "system-a",
          user_prompt_template: "template-a",
          topic_matchers: ["technology"],
          keyword_matchers: [],
          routing_priority: 100,
          fallback: true,
          settings: {},
          active: true
        },
        {
          id: 12,
          key: "news_image_prompt_optimizer",
          version: "v1.1-c",
          name: "Variant C",
          optimizer_provider: "openai",
          optimizer_model: "gpt-5.4-mini-2026-03-17",
          generation_provider: "openai",
          generation_model: "gpt-image-1",
          max_completion_tokens: 500,
          system_prompt: "system-c",
          user_prompt_template: "template-c",
          topic_matchers: ["politics"],
          keyword_matchers: ["vote"],
          routing_priority: 10,
          fallback: false,
          settings: {},
          active: true
        }
      ]), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const selection = await resolveImagePromptOptimizerConfig(env, {
      key: null,
      input: {
        title: "Transit vote today",
        headline: "City politics dominate the race",
        summary: "A close vote will decide the policy path.",
        topics: ["politics"],
        language: "en"
      }
    });

    assert.equal(selection.config.id, 12);
    assert.equal(selection.config.generationProvider, "openai");
    assert.equal(selection.config.generationModel, "gpt-image-1");
    assert.deepEqual(selection.matchedTopics, ["politics"]);
    assert.deepEqual(selection.matchedKeywords, ["vote"]);
    assert.equal(selection.fallbackReason, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
