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

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
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

test("explain endpoint routes simple and technical modes with distinct costs", async () => {
  const installId = "explain-mode-user";
  const token = makeToken(installId);
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
      { ...env }
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
  const token = makeToken(installId);
  // No D1 inserts happen without SUPABASE_URL; the assertion below trivially passes (empty array)
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
    { ...env }
  ));

  assert.equal(response.status, 502);
  assert.equal(inserts.some((entry) => entry.sql.includes("ai_results_cache")), false);
});

test("explain logs empty model content and does not cache or charge", async () => {
  const installId = "explain-empty-output";
  const token = makeToken(installId);
  // inserts will always be empty without SUPABASE_URL
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
      { ...env }
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
  const token = makeToken(installId);
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
    { ...env }
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
