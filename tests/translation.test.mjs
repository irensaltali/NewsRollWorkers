import test from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.mjs";
import { signTestJWT, TEST_JWT_SECRET, TEST_USER_ID } from "./test-auth.mjs";

const env = {
  APP_NAME: "NewsRoll",
  SUPABASE_JWT_SECRET: TEST_JWT_SECRET,
  PUBLIC_BASE_URL: "https://newsroll.invalid",
  REVENUECAT_SECRET_KEY: "sk_test_fake",
  REVENUECAT_PROJECT_ID: "proj_test_fake",
  OPENAI_API_KEY: "sk-test-fake"
};

function makeToken(userId = TEST_USER_ID) {
  return signTestJWT(userId, TEST_JWT_SECRET);
}

function sortedJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => sortedJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${sortedJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function createContentHash(body) {
  const source = {
    storyId: body.storyId,
    targetLanguage: body.targetLanguage,
    story: {
      id: body.story.id,
      title: body.story.title,
      text: body.story.text
    },
    comments: body.comments.map((comment) => ({
      id: comment.id,
      text: comment.text
    }))
  };
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sortedJson(source)));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function withMockedFetch(mocks, fn) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    const urlPath = url.split("?")[0];
    const context = { input, init, url, urlPath };

    for (const mock of mocks) {
      if (mock.matchEnd ? urlPath.endsWith(mock.matchEnd) : urlPath.includes(mock.match)) {
        mock.onMatch?.(context);
        const body = typeof mock.body === "function" ? await mock.body(context) : mock.body;
        const status = typeof mock.status === "function" ? await mock.status(context) : (mock.status ?? 200);
        return new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" }
        });
      }
    }

    return originalFetch(input, init);
  };

  return fn().finally(() => {
    globalThis.fetch = originalFetch;
  });
}

function makeTranslationBody(overrides = {}) {
  return {
    storyId: 101,
    targetLanguage: "tr",
    story: {
      id: 101,
      title: "Launch HN: Example",
      text: "Hello NewsRoll"
    },
    comments: [
      { id: 201, parentId: 101, author: "pg", text: "Great work", depth: 0 },
      { id: 202, parentId: 201, author: "dang", text: "Thanks for sharing", depth: 1 }
    ],
    ...overrides
  };
}

test("changed translation content hash charges the same user again", async () => {
  const installId = "install-translation-changed";
  const token = makeToken(installId);
  const originalBody = makeTranslationBody();
  const updatedBody = makeTranslationBody({
    comments: [
      { id: 201, parentId: 101, author: "pg", text: "Great work", depth: 0 },
      { id: 202, parentId: 201, author: "dang", text: "Thanks for the detailed launch notes", depth: 1 }
    ]
  });
  const oldHash = await createContentHash(originalBody);

  let spendCalls = 0;
  const response = await withMockedFetch([
    {
      matchEnd: `customers/${installId}`,
      body: { object: "customer", id: installId, active_entitlements: { object: "list", items: [{ object: "customer.active_entitlement", entitlement_id: "pro", expires_at: null }] } }
    },
    {
      matchEnd: `customers/${installId}/virtual_currencies`,
      body: { object: "list", items: [{ object: "virtual_currency_balance", currency_code: "credit", balance: 750 }] }
    },
    {
      match: `customers/${installId}/virtual_currencies/transactions`,
      onMatch: () => { spendCalls += 1; },
      body: { object: "list", items: [{ object: "virtual_currency_balance", currency_code: "credit", balance: 749 }] }
    },
    {
      match: "api.openai.com",
      body: {
        choices: [{
          message: {
            content: JSON.stringify({
              story: { title: "Merhaba HN", text: "Merhaba NewsRoll" },
              comments: [
                { id: 201, text: "Harika iş" },
                { id: 202, text: "Ayrıntılı lansman notları için teşekkürler" }
              ]
            })
          }
        }]
      }
    }
  ], async () => worker.fetch(
    new Request("https://example.com/v1/ai/translate", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`
      },
      body: JSON.stringify(updatedBody)
    }),
    { ...env }
  ));

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.cached, false);
  assert.equal(payload.charged, true);
  assert.equal(spendCalls, 1);
  assert.notEqual(payload.contentHash, oldHash);
  assert.equal(payload.comments[1].id, 202);
});

test("translation uses only request story text and does not crawl article bodies", async () => {
  const installId = "install-translation-crawl";
  const token = makeToken(installId);
  let hnItemRequests = 0;
  let crawlRequests = 0;
  let openAIRequestBody = null;
  const body = makeTranslationBody({
    storyId: 303,
    story: {
      id: 303,
      title: "Translate crawled link",
      text: "Request payload story text only.",
      url: "https://example.com/translated-article"
    }
  });

  const response = await withMockedFetch([
    {
      matchEnd: `customers/${installId}`,
      body: { object: "customer", id: installId, active_entitlements: { object: "list", items: [{ object: "customer.active_entitlement", entitlement_id: "pro", expires_at: null }] } }
    },
    {
      matchEnd: `customers/${installId}/virtual_currencies`,
      body: { object: "list", items: [{ object: "virtual_currency_balance", currency_code: "credit", balance: 750 }] }
    },
    {
      match: `customers/${installId}/virtual_currencies/transactions`,
      body: { object: "list", items: [{ object: "virtual_currency_balance", currency_code: "credit", balance: 749 }] }
    },
    {
      matchEnd: "/v0/item/303.json",
      onMatch: () => { hnItemRequests += 1; },
      body: {
        id: 303,
        type: "story",
        title: "Translate crawled link",
        text: "",
        url: "https://example.com/translated-article"
      }
    },
    {
      matchEnd: "/browser-rendering/crawl",
      onMatch: () => { crawlRequests += 1; },
      body: { success: true, result: "crawl-job-translation" }
    },
    {
      matchEnd: "/browser-rendering/crawl/crawl-job-translation",
      onMatch: () => { crawlRequests += 1; },
      body: {
        success: true,
        result: {
          status: "completed",
          records: [
            {
              url: "https://example.com/translated-article",
              markdown: "Crawled translation article body."
            }
          ]
        }
      }
    },
    {
      match: "api.openai.com",
      onMatch: ({ init }) => {
        openAIRequestBody = JSON.parse(init.body);
      },
      body: {
        choices: [{
          message: {
            content: JSON.stringify({
              story: { title: "TR baslik", text: "TR metin" },
              comments: [
                { id: 201, text: "Harika iş" },
                { id: 202, text: "Paylaştığın için teşekkürler" }
              ]
            })
          }
        }]
      }
    }
  ], async () => worker.fetch(
    new Request("https://example.com/v1/ai/translate", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`
      },
      body: JSON.stringify(body)
    }),
    {
      ...env,
      CLOUDFLARE_ACCOUNT_ID: "acct_test",
      CLOUDFLARE_API_TOKEN: "cf_token_test"
    }
  ));

  assert.equal(response.status, 200);
  assert.equal(hnItemRequests, 0);
  assert.equal(crawlRequests, 0);
  assert.match(openAIRequestBody.messages[1].content, /Translate crawled link/);
  assert.match(openAIRequestBody.messages[1].content, /Request payload story text only\./);
  assert.doesNotMatch(openAIRequestBody.messages[1].content, /Crawled translation article body\./);
});

test("translation returns 502 when model output fails validation", async () => {
  const installId = "install-translation-retry";
  const token = makeToken(installId);
  const body = makeTranslationBody();

  let openAICalls = 0;
  const response = await withMockedFetch([
    {
      matchEnd: `customers/${installId}`,
      body: { object: "customer", id: installId, active_entitlements: { object: "list", items: [{ object: "customer.active_entitlement", entitlement_id: "pro", expires_at: null }] } }
    },
    {
      matchEnd: `customers/${installId}/virtual_currencies`,
      body: { object: "list", items: [{ object: "virtual_currency_balance", currency_code: "credit", balance: 750 }] }
    },
    {
      match: `customers/${installId}/virtual_currencies/transactions`,
      body: { object: "list", items: [{ object: "virtual_currency_balance", currency_code: "credit", balance: 749 }] }
    },
    {
      match: "api.openai.com",
      onMatch: () => { openAICalls += 1; },
      body: { choices: [{ message: { content: "not valid json" } }] }
    }
  ], async () => worker.fetch(
    new Request("https://example.com/v1/ai/translate", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`
      },
      body: JSON.stringify(body)
    }),
    { ...env }
  ));

  assert.equal(response.status, 502);
  assert.equal(openAICalls, 2);
});

test("translation returns 503 when OpenAI is not configured", async () => {
  const installId = "install-translation-no-key";
  const token = makeToken(installId);
  const body = makeTranslationBody();

  const response = await withMockedFetch([
    {
      matchEnd: `customers/${installId}`,
      body: { object: "customer", id: installId, active_entitlements: { object: "list", items: [{ object: "customer.active_entitlement", entitlement_id: "pro", expires_at: null }] } }
    }
  ], async () => worker.fetch(
    new Request("https://example.com/v1/ai/translate", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`
      },
      body: JSON.stringify(body)
    }),
    {
      ...env,
      OPENAI_API_KEY: ""
    }
  ));

  assert.equal(response.status, 503);
  const payload = await response.json();
  assert.equal(payload.details.code, "ai_provider_unavailable");
  assert.equal(payload.details.provider, "openai");
});
