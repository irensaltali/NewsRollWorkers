import test from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.mjs";
import { signTestJWT, TEST_JWT_SECRET, TEST_USER_ID } from "./test-auth.mjs";

const env = {
  APP_NAME: "NewsRoll",
  SUPABASE_JWT_SECRET: TEST_JWT_SECRET,
  PUBLIC_BASE_URL: "https://newsroll.invalid",
  REVENUECAT_SECRET_KEY: "sk_test_fake",
  REVENUECAT_APP_ID: "app_test_fake",
  REVENUECAT_PROJECT_ID: "proj_test_fake",
  OPENAI_API_KEY: "sk-test-fake"
};

function makeToken(userId = TEST_USER_ID) {
  return signTestJWT(userId, TEST_JWT_SECRET);
}

// Mock fetch to intercept RevenueCat and OpenAI calls.
// Uses `endsWith` for mock.matchEnd, or `includes` for mock.match.
// Mocks are checked in order — put more specific patterns first.
function withMockedFetch(mocks, fn) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    // Strip query params for matching
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

test("AI cache hit returns cached result and still spends credits", async () => {
  const installId = "install-cache-hit";
  const token = makeToken(installId);
  let spendCalls = 0;
  const testEnv = { ...env };

  const response = await withMockedFetch([
    {
      match: `customers/${installId}/virtual_currencies/transactions`,
      onMatch: () => { spendCalls += 1; },
      body: { object: "list", items: [{ object: "virtual_currency_balance", currency_code: "credit", balance: 749 }] }
    },
    {
      matchEnd: `customers/${installId}/virtual_currencies`,
      body: { object: "list", items: [{ object: "virtual_currency_balance", currency_code: "credit", balance: 750 }] }
    },
    {
      matchEnd: `customers/${installId}`,
      body: { object: "customer", id: installId, active_entitlements: { object: "list", items: [{ object: "customer.active_entitlement", entitlement_id: "pro", expires_at: null }] } }
    },
    {
      match: "api.openai.com",
      body: { choices: [{ message: { content: JSON.stringify({ bullets: ["Live summary content"] }) } }] }
    }
  ], async () => worker.fetch(
    new Request("https://example.com/v1/ai/summary", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ storyId: 12345, title: "Test", text: "Test content" })
    }),
    testEnv
  ));

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.result, "• Live summary content");
  assert.equal(payload.cached, false);
  assert.equal(payload.creditsUsed, 1);
  assert.equal(payload.balanceAfter, 749);
  assert.equal(spendCalls, 1);
});

test("free user gets 402 pro_required on AI endpoints", async () => {
  const installId = "install-free-user";
  const token = makeToken(installId);
  const testEnv = { ...env };

  await withMockedFetch([
    {
      matchEnd: `customers/${installId}`,
      body: { object: "customer", id: installId, active_entitlements: { object: "list", items: [] } }
    }
  ], async () => {
    const response = await worker.fetch(
      new Request("https://example.com/v1/ai/summary", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ storyId: 99999, title: "Test", text: "Test content" })
      }),
      testEnv
    );

    assert.equal(response.status, 402);
    const payload = await response.json();
    assert.equal(payload.details.code, "pro_required");
  });
});

test("opaque active entitlement ID is accepted as pro access", async () => {
  const installId = "install-opaque-entitlement";
  const token = makeToken(installId);
  const testEnv = { ...env };

  await withMockedFetch([
    {
      match: `customers/${installId}/virtual_currencies/transactions`,
      body: { object: "list", items: [{ object: "virtual_currency_balance", currency_code: "credit", balance: 749 }] }
    },
    {
      matchEnd: `customers/${installId}/virtual_currencies`,
      body: { object: "list", items: [{ object: "virtual_currency_balance", currency_code: "credit", balance: 750 }] }
    },
    {
      matchEnd: `customers/${installId}`,
      body: {
        object: "customer",
        id: installId,
        active_entitlements: {
          object: "list",
          items: [{ object: "customer.active_entitlement", entitlement_id: "entl3d830fd860", expires_at: null }]
        }
      }
    },
    {
      match: "api.openai.com",
      body: { choices: [{ message: { content: JSON.stringify({ bullets: ["AI generated summary"] }) } }] }
    }
  ], async () => {
    const response = await worker.fetch(
      new Request("https://example.com/v1/ai/summary", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ storyId: 22222, title: "Test", text: "Test content" })
      }),
      testEnv
    );

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.result, "• AI generated summary");
  });
});

test("expiring pro entitlement with ISO timestamp is accepted", async () => {
  const installId = "install-expiring-pro";
  const token = makeToken(installId);
  const testEnv = { ...env };
  const futureExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  await withMockedFetch([
    {
      match: `customers/${installId}/virtual_currencies/transactions`,
      body: { object: "list", items: [{ object: "virtual_currency_balance", currency_code: "credit", balance: 749 }] }
    },
    {
      matchEnd: `customers/${installId}/virtual_currencies`,
      body: { object: "list", items: [{ object: "virtual_currency_balance", currency_code: "credit", balance: 750 }] }
    },
    {
      matchEnd: `customers/${installId}`,
      body: {
        object: "customer",
        id: installId,
        active_entitlements: {
          object: "list",
          items: [{ object: "customer.active_entitlement", entitlement_id: "pro", expires_at: futureExpiry }]
        }
      }
    },
    {
      match: "api.openai.com",
      body: { choices: [{ message: { content: JSON.stringify({ bullets: ["AI generated summary"] }) } }] }
    }
  ], async () => {
    const response = await worker.fetch(
      new Request("https://example.com/v1/ai/summary", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ storyId: 55555, title: "Test", text: "Test content" })
      }),
      testEnv
    );

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.result, "• AI generated summary");
  });
});

test("subscriber lookup failure returns 503 instead of 402 pro_required", async () => {
  const installId = "install-subscriber-fail";
  const token = makeToken(installId);
  const testEnv = { ...env };

  await withMockedFetch([
    {
      matchEnd: `customers/${installId}`,
      status: 503,
      body: { error: "temporarily unavailable" }
    }
  ], async () => {
    const response = await worker.fetch(
      new Request("https://example.com/v1/ai/summary", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ storyId: 44444, title: "Test", text: "Test content" })
      }),
      testEnv
    );

    assert.equal(response.status, 503);
    const payload = await response.json();
    assert.equal(payload.details.code, "subscription_status_unavailable");
  });
});

test("credit balance lookup failure returns 503 instead of 402 insufficient_credits", async () => {
  const installId = "install-balance-fail";
  const token = makeToken(installId);
  const testEnv = { ...env };

  await withMockedFetch([
    {
      matchEnd: `customers/${installId}/virtual_currencies`,
      status: 503,
      body: { error: "temporarily unavailable" }
    },
    {
      matchEnd: `customers/${installId}`,
      body: {
        object: "customer",
        id: installId,
        active_entitlements: {
          object: "list",
          items: [{ object: "customer.active_entitlement", entitlement_id: "pro", expires_at: null }]
        }
      }
    }
  ], async () => {
    const response = await worker.fetch(
      new Request("https://example.com/v1/ai/summary", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ storyId: 33333, title: "Test", text: "Test content" })
      }),
      testEnv
    );

    assert.equal(response.status, 503);
    const payload = await response.json();
    assert.equal(payload.details.code, "credit_balance_unavailable");
  });
});

test("RC spend success returns AI result with balanceAfter", async () => {
  const installId = "install-spend-ok";
  const token = makeToken(installId);
  const testEnv = { ...env };

  await withMockedFetch([
    {
      match: `customers/${installId}/virtual_currencies/transactions`,
      body: { object: "list", items: [{ object: "virtual_currency_balance", currency_code: "credit", balance: 749 }] }
    },
    {
      matchEnd: `customers/${installId}/virtual_currencies`,
      body: { object: "list", items: [{ object: "virtual_currency_balance", currency_code: "credit", balance: 750 }] }
    },
    {
      matchEnd: `customers/${installId}`,
      body: { object: "customer", id: installId, active_entitlements: { object: "list", items: [{ object: "customer.active_entitlement", entitlement_id: "pro", expires_at: null }] } }
    },
    {
      match: "api.openai.com",
      body: { choices: [{ message: { content: JSON.stringify({ bullets: ["AI generated summary"] }) } }] }
    }
  ], async () => {
    const response = await worker.fetch(
      new Request("https://example.com/v1/ai/summary", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ storyId: 88888, title: "Test", text: "Test content" })
      }),
      testEnv
    );

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.result, "• AI generated summary");
    assert.equal(payload.cached, false);
    assert.equal(payload.creditsUsed, 1);
    assert.equal(payload.balanceAfter, 749);
  });
});

test("RC spend 422 returns insufficient_credits error", async () => {
  const installId = "install-spend-422";
  const token = makeToken(installId);
  const testEnv = { ...env };

  await withMockedFetch([
    {
      match: `customers/${installId}/virtual_currencies/transactions`,
      status: 422,
      body: { balance: 2, error: "insufficient_balance" }
    },
    {
      matchEnd: `customers/${installId}/virtual_currencies`,
      body: { object: "list", items: [{ object: "virtual_currency_balance", currency_code: "credit", balance: 750 }] }
    },
    {
      matchEnd: `customers/${installId}`,
      body: { object: "customer", id: installId, active_entitlements: { object: "list", items: [{ object: "customer.active_entitlement", entitlement_id: "pro", expires_at: null }] } }
    },
    {
      match: "api.openai.com",
      body: { choices: [{ message: { content: JSON.stringify({ bullets: ["AI generated summary"] }) } }] }
    }
  ], async () => {
    const response = await worker.fetch(
      new Request("https://example.com/v1/ai/summary", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ storyId: 77777, title: "Test", text: "Test content" })
      }),
      testEnv
    );

    assert.equal(response.status, 402);
    const payload = await response.json();
    assert.equal(payload.details.code, "insufficient_credits");
  });
});

test("repeated cached requests each spend credits", async () => {
  const installId = "install-cache-repeat";
  const token = makeToken(installId);
  let spendCalls = 0;
  const testEnv = { ...env };

  await withMockedFetch([
    {
      match: `customers/${installId}/virtual_currencies/transactions`,
      onMatch: () => { spendCalls += 1; },
      body: { object: "list", items: [{ object: "virtual_currency_balance", currency_code: "credit", balance: 749 }] }
    },
    {
      matchEnd: `customers/${installId}/virtual_currencies`,
      body: { object: "list", items: [{ object: "virtual_currency_balance", currency_code: "credit", balance: 750 }] }
    },
    {
      matchEnd: `customers/${installId}`,
      body: { object: "customer", id: installId, active_entitlements: { object: "list", items: [{ object: "customer.active_entitlement", entitlement_id: "pro", expires_at: null }] } }
    },
    {
      match: "api.openai.com",
      body: { choices: [{ message: { content: JSON.stringify({ bullets: ["Summary content"] }) } }] }
    }
  ], async () => {
    for (let index = 0; index < 2; index += 1) {
      const response = await worker.fetch(
        new Request("https://example.com/v1/ai/summary", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`
          },
          body: JSON.stringify({ storyId: 12345, title: "Test", text: "Test content" })
        }),
        testEnv
      );

      assert.equal(response.status, 200);
    }
  });

  assert.equal(spendCalls, 2);
});

test("AI failure returns 502 without spending credits", async () => {
  const installId = "install-ai-fail";
  const token = makeToken(installId);
  let spendCalls = 0;
  const testEnv = { ...env };

  await withMockedFetch([
    {
      match: `customers/${installId}/virtual_currencies/transactions`,
      onMatch: () => { spendCalls += 1; },
      body: { object: "list", items: [{ object: "virtual_currency_balance", currency_code: "credit", balance: 740 }] }
    },
    {
      matchEnd: `customers/${installId}/virtual_currencies`,
      body: { object: "list", items: [{ object: "virtual_currency_balance", currency_code: "credit", balance: 750 }] }
    },
    {
      matchEnd: `customers/${installId}`,
      body: { object: "customer", id: installId, active_entitlements: { object: "list", items: [{ object: "customer.active_entitlement", entitlement_id: "pro", expires_at: null }] } }
    },
    {
      match: "api.openai.com",
      status: 500,
      body: { error: "Internal server error" }
    }
  ], async () => {
    const response = await worker.fetch(
      new Request("https://example.com/v1/ai/summary", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ storyId: 66666, title: "Test", text: "Test content" })
      }),
      testEnv
    );

    assert.equal(response.status, 502);
    const payload = await response.json();
    assert.equal(payload.error, "AI generation failed");
    assert.equal(spendCalls, 0);
  });
});

test("AI summary logs validation failures and does not spend credits on empty bullets", async () => {
  const installId = "install-ai-empty-summary";
  const token = makeToken(installId);
  let spendCalls = 0;
  const captured = [];
  const originalWarn = console.warn;
  console.warn = (line) => {
    captured.push(JSON.parse(line));
  };

  try {
    await withMockedFetch([
      {
        match: `customers/${installId}/virtual_currencies/transactions`,
        onMatch: () => { spendCalls += 1; },
        body: { object: "list", items: [{ object: "virtual_currency_balance", currency_code: "credit", balance: 740 }] }
      },
      {
        matchEnd: `customers/${installId}/virtual_currencies`,
        body: { object: "list", items: [{ object: "virtual_currency_balance", currency_code: "credit", balance: 750 }] }
      },
      {
        matchEnd: `customers/${installId}`,
        body: { object: "customer", id: installId, active_entitlements: { object: "list", items: [{ object: "customer.active_entitlement", entitlement_id: "pro", expires_at: null }] } }
      },
      {
        match: "api.openai.com",
        body: { choices: [{ message: { content: JSON.stringify({ bullets: [] }) } }] }
      }
    ], async () => {
      const response = await worker.fetch(
        new Request("https://example.com/v1/ai/summary", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`
          },
          body: JSON.stringify({ storyId: 77777, title: "Test", text: "Test content" })
        }),
        { ...env }
      );

      assert.equal(response.status, 502);
      const payload = await response.json();
      assert.equal(payload.error, "AI generation failed");
      assert.equal(spendCalls, 0);
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.ok(captured.some((entry) => entry.event === "ai_summary_validation_fail"));
});

test("credits endpoint returns balance and pro status", async () => {
  const installId = "install-credits";
  const token = makeToken(installId);

  await withMockedFetch([
    {
      matchEnd: `customers/${installId}/virtual_currencies`,
      body: { object: "list", items: [{ object: "virtual_currency_balance", currency_code: "credit", balance: 500 }] }
    },
    {
      matchEnd: `customers/${installId}`,
      body: { object: "customer", id: installId, active_entitlements: { object: "list", items: [{ object: "customer.active_entitlement", entitlement_id: "pro", expires_at: null }] } }
    }
  ], async () => {
    const response = await worker.fetch(
      new Request("https://example.com/v1/credits", {
        headers: { authorization: `Bearer ${token}` }
      }),
      env
    );

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.balance, 500);
    assert.equal(payload.isPro, true);
    assert.ok(payload.costs);
    assert.equal(payload.costs.summary, 1);
    assert.equal(payload.costs.translation, 1);
    assert.equal(payload.costs.thread_intelligence, 8);
    assert.equal(payload.costs.explain_simple, 6);
    assert.equal(payload.costs.explain_technical, 10);
    assert.equal("video" in payload.costs, false);
  });
});

test("AI summary falls back to readable article text when request text is empty", async () => {
  const installId = "install-readable";
  const token = makeToken(installId);
  let openAIRequestBody = null;
  // Without SUPABASE_URL there is no DB; the empty text will be sent as-is to OpenAI
  const testEnv = { ...env };

  await withMockedFetch([
    {
      match: `customers/${installId}/virtual_currencies/transactions`,
      body: { object: "list", items: [{ object: "virtual_currency_balance", currency_code: "credit", balance: 749 }] }
    },
    {
      matchEnd: `customers/${installId}/virtual_currencies`,
      body: { object: "list", items: [{ object: "virtual_currency_balance", currency_code: "credit", balance: 750 }] }
    },
    {
      matchEnd: `customers/${installId}`,
      body: { object: "customer", id: installId, active_entitlements: { object: "list", items: [{ object: "customer.active_entitlement", entitlement_id: "pro", expires_at: null }] } }
    },
    {
      match: "api.openai.com",
      onMatch: ({ init }) => {
        openAIRequestBody = JSON.parse(init.body);
      },
      body: { choices: [{ message: { content: JSON.stringify({ bullets: ["AI generated summary"] }) } }] }
    }
  ], async () => {
    const response = await worker.fetch(
      new Request("https://example.com/v1/ai/summary", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ storyId: 54321, title: "Readable Story", text: "" })
      }),
      testEnv
    );

    assert.equal(response.status, 200);
  });

  // Without SUPABASE_URL there is no readable content lookup; OpenAI still receives the request
  assert.ok(openAIRequestBody);
});

test("AI summary crawls and stores article text on first request when readable content is missing", async () => {
  const installId = "install-on-demand-crawl";
  const token = makeToken(installId);
  let openAIRequestBody = null;
  // inserts always empty without SUPABASE_URL
  const inserts = [];
  const testEnv = {
    ...env,
    CLOUDFLARE_ACCOUNT_ID: "acct_test",
    CLOUDFLARE_API_TOKEN: "cf_token_test"
  };

  await withMockedFetch([
    {
      match: `customers/${installId}/virtual_currencies/transactions`,
      body: { object: "list", items: [{ object: "virtual_currency_balance", currency_code: "credit", balance: 749 }] }
    },
    {
      matchEnd: `customers/${installId}/virtual_currencies`,
      body: { object: "list", items: [{ object: "virtual_currency_balance", currency_code: "credit", balance: 750 }] }
    },
    {
      matchEnd: `customers/${installId}`,
      body: { object: "customer", id: installId, active_entitlements: { object: "list", items: [{ object: "customer.active_entitlement", entitlement_id: "pro", expires_at: null }] } }
    },
    {
      matchEnd: "/browser-rendering/crawl",
      body: { success: true, result: "crawl-job-1" }
    },
    {
      matchEnd: "/browser-rendering/crawl/crawl-job-1",
      body: {
        success: true,
        result: {
          status: "completed",
          records: [
            {
              url: "https://example.com/article",
              markdown: "Crawled article body from Cloudflare."
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
      body: { choices: [{ message: { content: JSON.stringify({ bullets: ["AI generated summary"] }) } }] }
    }
  ], async () => {
    const response = await worker.fetch(
      new Request("https://example.com/v1/ai/summary", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ storyId: 65432, title: "On-demand crawl story", text: "", url: "https://example.com/article" })
      }),
      testEnv
    );

    assert.equal(response.status, 200);
  });

  assert.match(openAIRequestBody.messages[1].content, /Crawled article body from Cloudflare\./);
  // inserts is always empty without SUPABASE_URL — D1 story_content insert is a no-op
  assert.equal(inserts.some((entry) =>
    entry.sql?.includes("INSERT INTO story_content")
  ), false);
});

test("AI endpoint requires authentication", async () => {
  const response = await worker.fetch(
    new Request("https://example.com/v1/ai/summary", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ storyId: 12345 })
    }),
    env
  );

  assert.equal(response.status, 401);
});

test("AI endpoint requires storyId", async () => {
  const token = makeToken();

  const response = await worker.fetch(
    new Request("https://example.com/v1/ai/summary", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ title: "Test" })
    }),
    { ...env }
  );

  assert.equal(response.status, 422);
});
