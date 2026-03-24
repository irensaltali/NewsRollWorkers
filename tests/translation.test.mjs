import test from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.mjs";
import { signInstallation } from "../src/security.mjs";

const env = {
  APP_NAME: "NewsRoll",
  INSTALLATION_TOKEN_SECRET: "test-installation-secret",
  SESSION_ENCRYPTION_SECRET: "test-session-secret",
  PUBLIC_BASE_URL: "https://newsroll.invalid",
  REVENUECAT_SECRET_KEY: "sk_test_fake",
  REVENUECAT_PROJECT_ID: "proj_test_fake",
  OPENAI_API_KEY: "sk-test-fake"
};

async function makeToken(installationId = "test-install") {
  return signInstallation(
    { installationId, platform: "ios", issuedAt: Date.now() },
    env.INSTALLATION_TOKEN_SECRET
  );
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

function createDb({ cacheRows = [], receipts = [], inserts = [], readableRows = [] } = {}) {
  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (sql.includes("ai_results_cache") && sql.includes("SELECT")) {
                const key = args[0];
                const row = cacheRows.find((entry) => entry.cacheKey === key);
                return row ? {
                  resultText: row.resultText,
                  resultType: row.resultType,
                  model: row.model,
                  createdAt: row.createdAt
                } : null;
              }

              if (sql.includes("ai_request_receipts") && sql.includes("SELECT")) {
                const [subscriberId, action, storyId, targetLanguage, contentHash] = args;
                const match = receipts.find((entry) =>
                  entry.subscriberId === subscriberId &&
                  entry.action === action &&
                  entry.storyId === storyId &&
                  (entry.targetLanguage ?? null) === (targetLanguage ?? null) &&
                  entry.contentHash === contentHash
                );
                return match ? { ok: 1 } : null;
              }

              if (sql.includes("story_content") && sql.includes("SELECT extracted_text AS extractedText")) {
                const storyId = args[0];
                const row = readableRows.find((entry) => entry.storyId === storyId);
                return row ? { extractedText: row.extractedText } : null;
              }

              return null;
            },
            async run() {
              inserts.push({ sql, args });
              if (sql.includes("ai_request_receipts")) {
                receipts.push({
                  subscriberId: args[0],
                  action: args[1],
                  storyId: args[2],
                  targetLanguage: args[3],
                  contentHash: args[4]
                });
              }
              if (sql.includes("ai_results_cache")) {
                cacheRows.push({
                  cacheKey: args[0],
                  resultType: args[1],
                  storyId: args[2],
                  resultText: args[3],
                  model: args[4],
                  expiresAt: args[5]
                });
              }
              return { meta: { changes: 1 } };
            }
          };
        }
      };
    }
  };
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

test("same user does not get charged again for the same cached translation", async () => {
  const installId = "install-translation-repeat";
  const token = await makeToken(installId);
  const body = makeTranslationBody();
  const contentHash = await createContentHash(body);
  const cacheKey = `translation:v2:${body.storyId}:${body.targetLanguage}:${contentHash}`;
  const inserts = [];
  const db = createDb({
    cacheRows: [{
      cacheKey,
      resultText: JSON.stringify({
        story: { id: 101, title: "Merhaba HN", text: "Merhaba NewsRoll" },
        comments: [
          { id: 201, text: "Harika iş" },
          { id: 202, text: "Paylaştığın için teşekkürler" }
        ],
        targetLanguage: "tr",
        contentHash
      }),
      resultType: "translation",
      model: "o1-mini",
      createdAt: "2026-03-20T00:00:00.000Z"
    }],
    receipts: [{
      subscriberId: installId,
      action: "translation",
      storyId: 101,
      targetLanguage: "tr",
      contentHash
    }],
    inserts
  });

  let spendCalls = 0;
  const response = await withMockedFetch([
    {
      matchEnd: `customers/${installId}`,
      body: { object: "customer", id: installId, active_entitlements: { object: "list", items: [{ object: "customer.active_entitlement", entitlement_id: "pro", expires_at: null }] } }
    },
    {
      match: `customers/${installId}/virtual_currencies/transactions`,
      onMatch: () => { spendCalls += 1; },
      body: { object: "list", items: [{ object: "virtual_currency_balance", currency_code: "credit", balance: 749 }] }
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
    { ...env, DB: db }
  ));

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.cached, true);
  assert.equal(payload.charged, false);
  assert.equal(payload.creditsUsed, 0);
  assert.equal(spendCalls, 0);
  assert.equal(inserts.filter((entry) => entry.sql.includes("ai_request_receipts")).length, 0);
});

test("different user is charged even when translation is served from cache", async () => {
  const cachedForUser = "install-translation-source";
  const requestingUser = "install-translation-other";
  const token = await makeToken(requestingUser);
  const body = makeTranslationBody();
  const contentHash = await createContentHash(body);
  const cacheKey = `translation:v2:${body.storyId}:${body.targetLanguage}:${contentHash}`;
  const db = createDb({
    cacheRows: [{
      cacheKey,
      resultText: JSON.stringify({
        story: { id: 101, title: "Merhaba HN", text: "Merhaba NewsRoll" },
        comments: [
          { id: 201, text: "Harika iş" },
          { id: 202, text: "Paylaştığın için teşekkürler" }
        ],
        targetLanguage: "tr",
        contentHash
      }),
      resultType: "translation",
      model: "o1-mini",
      createdAt: "2026-03-20T00:00:00.000Z"
    }],
    receipts: [{
      subscriberId: cachedForUser,
      action: "translation",
      storyId: 101,
      targetLanguage: "tr",
      contentHash
    }]
  });

  let spendCalls = 0;
  const response = await withMockedFetch([
    {
      matchEnd: `customers/${requestingUser}`,
      body: { object: "customer", id: requestingUser, active_entitlements: { object: "list", items: [{ object: "customer.active_entitlement", entitlement_id: "pro", expires_at: null }] } }
    },
    {
      matchEnd: `customers/${requestingUser}/virtual_currencies`,
      body: { object: "list", items: [{ object: "virtual_currency_balance", currency_code: "credit", balance: 750 }] }
    },
    {
      match: `customers/${requestingUser}/virtual_currencies/transactions`,
      onMatch: () => { spendCalls += 1; },
      body: { object: "list", items: [{ object: "virtual_currency_balance", currency_code: "credit", balance: 749 }] }
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
    { ...env, DB: db }
  ));

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.cached, true);
  assert.equal(payload.charged, true);
  assert.equal(payload.creditsUsed, 1);
  assert.equal(payload.balanceAfter, 749);
  assert.equal(spendCalls, 1);
});

test("changed translation content hash charges the same user again", async () => {
  const installId = "install-translation-changed";
  const token = await makeToken(installId);
  const originalBody = makeTranslationBody();
  const updatedBody = makeTranslationBody({
    comments: [
      { id: 201, parentId: 101, author: "pg", text: "Great work", depth: 0 },
      { id: 202, parentId: 201, author: "dang", text: "Thanks for the detailed launch notes", depth: 1 }
    ]
  });
  const oldHash = await createContentHash(originalBody);
  const inserts = [];
  const db = createDb({
    receipts: [{
      subscriberId: installId,
      action: "translation",
      storyId: 101,
      targetLanguage: "tr",
      contentHash: oldHash
    }],
    inserts
  });

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
    { ...env, DB: db }
  ));

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.cached, false);
  assert.equal(payload.charged, true);
  assert.equal(spendCalls, 1);
  assert.notEqual(payload.contentHash, oldHash);
  assert.equal(payload.comments[1].id, 202);
});

test("translation crawls and stores article text on first request when story text is missing", async () => {
  const installId = "install-translation-crawl";
  const token = await makeToken(installId);
  const inserts = [];
  const db = createDb({ inserts });
  let openAIRequestBody = null;
  const body = makeTranslationBody({
    storyId: 303,
    story: {
      id: 303,
      title: "Translate crawled link",
      text: "",
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
      body: { success: true, result: "crawl-job-translation" }
    },
    {
      matchEnd: "/browser-rendering/crawl/crawl-job-translation",
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
      CLOUDFLARE_API_TOKEN: "cf_token_test",
      DB: db
    }
  ));

  assert.equal(response.status, 200);
  assert.match(openAIRequestBody.messages[1].content, /Crawled translation article body\./);
  assert.ok(inserts.some((entry) =>
    entry.sql.includes("INSERT INTO story_content") &&
    entry.args[0] === 303 &&
    entry.args[1] === "crawl" &&
    entry.args[2] === "Crawled translation article body."
  ));
});

test("translation returns 502 when model output fails validation", async () => {
  const installId = "install-translation-retry";
  const token = await makeToken(installId);
  const body = makeTranslationBody();
  const inserts = [];
  const db = createDb({ inserts });

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
    { ...env, DB: db }
  ));

  assert.equal(response.status, 502);
  assert.equal(openAICalls, 2);
});

test("translation returns 503 when OpenAI is not configured", async () => {
  const installId = "install-translation-no-key";
  const token = await makeToken(installId);
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
      OPENAI_API_KEY: "",
      DB: createDb()
    }
  ));

  assert.equal(response.status, 503);
  const payload = await response.json();
  assert.equal(payload.details.code, "ai_provider_unavailable");
  assert.equal(payload.details.provider, "openai");
});
