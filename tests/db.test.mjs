import test from "node:test";
import assert from "node:assert/strict";

import {
  clearRSSItemCrawlFailure,
  getImagePromptOptimizerConfig,
  markRSSItemCrawlFailure,
  resolveImagePromptOptimizerConfig,
  storeReadableContent,
  storeStoryExplanation,
  storeStorySummary
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
