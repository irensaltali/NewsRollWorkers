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

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function createDb({ cacheRows = [], receipts = [], inserts = [] } = {}) {
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

function makeThreadBody(overrides = {}) {
  return {
    storyId: 401,
    title: "Show HN: Thread analyzer",
    comments: [
      { id: 501, parentId: 401, author: "pg", text: "This is thoughtful.", depth: 0 },
      { id: 502, parentId: 501, author: "dang", text: "The UX tradeoff is real.", depth: 1 }
    ],
    ...overrides
  };
}

async function createThreadContentHash(body) {
  return sha256Hex(sortedJson({
    storyId: body.storyId,
    title: body.title,
    comments: body.comments.map((comment) => ({ id: comment.id, text: comment.text }))
  }));
}

function makeExplainBody(overrides = {}) {
  return {
    storyId: 701,
    title: "Launch HN: Explain modes",
    text: "A detailed article about rollout tradeoffs.",
    level: "simple",
    ...overrides
  };
}

async function createExplainContentHash(body) {
  return sha256Hex(sortedJson({
    storyId: body.storyId,
    title: body.title,
    text: body.text
  }));
}

function customerMocks(appUserId, { balance = 750, spendBalance = 740 } = {}) {
  return [
    {
      matchEnd: `customers/${appUserId}`,
      body: {
        object: "customer",
        id: appUserId,
        active_entitlements: {
          object: "list",
          items: [{ object: "customer.active_entitlement", entitlement_id: "pro", expires_at: null }]
        }
      }
    },
    {
      matchEnd: `customers/${appUserId}/virtual_currencies`,
      body: { object: "list", items: [{ object: "virtual_currency_balance", currency_code: "credit", balance }] }
    },
    {
      match: `customers/${appUserId}/virtual_currencies/transactions`,
      body: { object: "list", items: [{ object: "virtual_currency_balance", currency_code: "credit", balance: spendBalance }] }
    }
  ];
}

function withSpendCounter(mocks, counter) {
  return mocks.map((mock) => ({
    ...mock,
    onMatch: (mock.match ?? mock.matchEnd ?? "").includes("/transactions")
      ? () => { counter.count += 1; }
      : mock.onMatch
  }));
}

test("same user does not get charged again for the same cached thread intelligence result", async () => {
  const installId = "thread-same-user";
  const token = await makeToken(installId);
  const body = makeThreadBody();
  const contentHash = await createThreadContentHash(body);
  const cacheKey = `thread_intelligence:v1:${body.storyId}:${contentHash}`;
  const db = createDb({
    cacheRows: [{
      cacheKey,
      resultText: JSON.stringify({
        summary: "The thread clusters around product-market fit and onboarding.",
        keyInsights: ["Signal one", "Signal two"],
        discussionShape: "mixed",
        contentHash
      }),
      resultType: "thread_intelligence",
      model: "o4-mini",
      createdAt: "2026-03-21T00:00:00.000Z"
    }],
    receipts: [{
      subscriberId: installId,
      action: "thread_intelligence",
      storyId: body.storyId,
      targetLanguage: null,
      contentHash
    }]
  });

  const spendCounter = { count: 0 };
  const response = await withMockedFetch(
    withSpendCounter(customerMocks(installId), spendCounter),
    async () => worker.fetch(
      new Request("https://example.com/v1/ai/thread-intelligence", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`
        },
        body: JSON.stringify(body)
      }),
      { ...env, DB: db }
    )
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.cached, true);
  assert.equal(payload.charged, false);
  assert.equal(payload.creditsUsed, 0);
  assert.equal(spendCounter.count, 0);
});

test("different user is charged when cached thread intelligence is reused", async () => {
  const cachedFor = "thread-origin-user";
  const requestingUser = "thread-requesting-user";
  const token = await makeToken(requestingUser);
  const body = makeThreadBody();
  const contentHash = await createThreadContentHash(body);
  const cacheKey = `thread_intelligence:v1:${body.storyId}:${contentHash}`;
  const db = createDb({
    cacheRows: [{
      cacheKey,
      resultText: JSON.stringify({
        summary: "The thread clusters around product-market fit and onboarding.",
        keyInsights: ["Signal one", "Signal two"],
        discussionShape: "mixed",
        contentHash
      }),
      resultType: "thread_intelligence",
      model: "o4-mini",
      createdAt: "2026-03-21T00:00:00.000Z"
    }],
    receipts: [{
      subscriberId: cachedFor,
      action: "thread_intelligence",
      storyId: body.storyId,
      targetLanguage: null,
      contentHash
    }]
  });

  const spendCounter = { count: 0 };
  const response = await withMockedFetch(
    withSpendCounter(customerMocks(requestingUser, { balance: 800, spendBalance: 792 }), spendCounter),
    async () => worker.fetch(
      new Request("https://example.com/v1/ai/thread-intelligence", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`
        },
        body: JSON.stringify(body)
      }),
      { ...env, DB: db }
    )
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.cached, true);
  assert.equal(payload.charged, true);
  assert.equal(payload.creditsUsed, 8);
  assert.equal(payload.balanceAfter, 792);
  assert.equal(spendCounter.count, 1);
});

test("explain endpoint routes simple and technical modes with distinct costs", async () => {
  const installId = "explain-mode-user";
  const token = await makeToken(installId);
  const modeRequests = [];

  async function sendExplain(level) {
    return withMockedFetch([
      ...customerMocks(installId, { balance: 900, spendBalance: level === "simple" ? 894 : 884 }),
      {
        match: "api.openai.com",
        onMatch: ({ init }) => {
          modeRequests.push(JSON.parse(init.body).messages[1].content);
        },
        body: {
          choices: [{
            message: {
              content: JSON.stringify({
                title: level === "simple" ? "Plain-English summary" : "Technical readout",
                sections: [
                  { heading: "Overview", body: "Body copy" }
                ],
                followUps: ["What changes at scale?"],
                level
              })
            }
          }]
        }
      }
    ], async () => worker.fetch(
      new Request("https://example.com/v1/ai/explain", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`
        },
        body: JSON.stringify(makeExplainBody({ level }))
      }),
      { ...env, DB: createDb() }
    ));
  }

  const simpleResponse = await sendExplain("simple");
  const technicalResponse = await sendExplain("technical");

  assert.equal(simpleResponse.status, 200);
  assert.equal(technicalResponse.status, 200);

  const simplePayload = await simpleResponse.json();
  const technicalPayload = await technicalResponse.json();
  assert.equal(simplePayload.level, "simple");
  assert.equal(simplePayload.creditsUsed, 6);
  assert.equal(technicalPayload.level, "technical");
  assert.equal(technicalPayload.creditsUsed, 10);
  assert.equal(modeRequests.some((content) => content.includes('"level":"simple"')), true);
  assert.equal(modeRequests.some((content) => content.includes('"level":"technical"')), true);
});

test("thread intelligence rejects malformed AI output without caching it", async () => {
  const installId = "thread-invalid-output";
  const token = await makeToken(installId);
  const inserts = [];
  const response = await withMockedFetch([
    ...customerMocks(installId),
    {
      match: "api.openai.com",
      body: { choices: [{ message: { content: "not valid json" } }] }
    }
  ], async () => worker.fetch(
    new Request("https://example.com/v1/ai/thread-intelligence", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`
      },
      body: JSON.stringify(makeThreadBody())
    }),
    { ...env, DB: createDb({ inserts }) }
  ));

  assert.equal(response.status, 502);
  assert.equal(inserts.some((entry) => entry.sql.includes("ai_results_cache")), false);
});

test("explain logs empty model content and does not cache or charge", async () => {
  const installId = "explain-empty-output";
  const token = await makeToken(installId);
  const inserts = [];
  const captured = [];
  const originalWarn = console.warn;
  console.warn = (line) => {
    captured.push(JSON.parse(line));
  };

  try {
    const spendCounter = { count: 0 };
    const response = await withMockedFetch([
      ...withSpendCounter(customerMocks(installId, { balance: 900, spendBalance: 894 }), spendCounter),
      {
        match: "api.openai.com",
        body: {
          choices: [{
            message: {
              content: "   "
            }
          }]
        }
      }
    ], async () => worker.fetch(
      new Request("https://example.com/v1/ai/explain", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`
        },
        body: JSON.stringify(makeExplainBody({ level: "simple" }))
      }),
      {
        ...env,
        DB: createDb({ inserts })
      }
    ));

    assert.equal(response.status, 502);
    assert.equal(inserts.some((entry) => entry.sql.includes("ai_results_cache")), false);
    assert.equal(spendCounter.count, 0);
  } finally {
    console.warn = originalWarn;
  }

  assert.ok(captured.some((entry) => entry.event === "ai_empty_content"));
});

test("changed thread comments produce a new hash and charge the same user again", async () => {
  const installId = "thread-changed-user";
  const token = await makeToken(installId);
  const original = makeThreadBody();
  const updated = makeThreadBody({
    comments: [
      { id: 501, parentId: 401, author: "pg", text: "This is thoughtful.", depth: 0 },
      { id: 502, parentId: 501, author: "dang", text: "The UX tradeoff is real, but the launch copy helps.", depth: 1 }
    ]
  });
  const oldHash = await createThreadContentHash(original);

  const spendCounter = { count: 0 };
  const response = await withMockedFetch([
    ...withSpendCounter(customerMocks(installId, { balance: 800, spendBalance: 792 }), spendCounter),
    {
      match: "api.openai.com",
      body: {
        choices: [{
          message: {
            content: JSON.stringify({
              summary: "The updated thread spends more time on launch messaging.",
              keyInsights: ["Messaging quality becomes part of the product critique."],
              discussionShape: "mixed"
            })
          }
        }]
      }
    }
  ], async () => worker.fetch(
    new Request("https://example.com/v1/ai/thread-intelligence", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`
      },
      body: JSON.stringify(updated)
    }),
    {
      ...env,
      DB: createDb({
        receipts: [{
          subscriberId: installId,
          action: "thread_intelligence",
          storyId: original.storyId,
          targetLanguage: null,
          contentHash: oldHash
        }]
      })
    }
  ));

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.notEqual(payload.contentHash, oldHash);
  assert.equal(payload.charged, true);
  assert.equal(spendCounter.count, 1);
});

test("changed article text produces a new explain hash", async () => {
  const original = makeExplainBody({ text: "A detailed article about rollout tradeoffs." });
  const updated = makeExplainBody({ text: "A detailed article about rollout tradeoffs and billing implications." });

  const originalHash = await createExplainContentHash(original);
  const updatedHash = await createExplainContentHash(updated);

  assert.notEqual(originalHash, updatedHash);
});
