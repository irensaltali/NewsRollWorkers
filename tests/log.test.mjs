import test from "node:test";
import assert from "node:assert/strict";

import * as log from "../src/log.mjs";
import worker from "../src/index.mjs";
import { signInstallation } from "../src/security.mjs";

const env = {
  APP_NAME: "NewsRoll",
  INSTALLATION_TOKEN_SECRET: "test-installation-secret",
  SESSION_ENCRYPTION_SECRET: "test-session-secret",
  PUBLIC_BASE_URL: "https://newsroll.invalid",
  REVENUECAT_SECRET_KEY: "sk_test_fake",
  REVENUECAT_PROJECT_ID: "proj_test_fake"
};

function createDb() {
  return {
    prepare() {
      return {
        bind() {
          return {
            async first() {
              return null;
            },
            async all() {
              return { results: [] };
            },
            async run() {
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

    for (const mock of mocks) {
      if (mock.matchEnd ? urlPath.endsWith(mock.matchEnd) : urlPath.includes(mock.match)) {
        const body = typeof mock.body === "function" ? await mock.body({ input, init, url, urlPath }) : mock.body;
        const status = typeof mock.status === "function" ? await mock.status({ input, init, url, urlPath }) : (mock.status ?? 200);
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

test("structured logs inject a message field when one is not provided", () => {
  const originalWarn = console.warn;
  let captured = null;
  console.warn = (line) => {
    captured = JSON.parse(line);
  };

  try {
    log.warn({
      event: "request",
      method: "POST",
      path: "/v1/ai/summary",
      route: "ai_summary",
      status: 402
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(captured.message, "POST /v1/ai/summary -> 402 [ai_summary]");
  assert.equal(captured.event, "request");
});

test("structured logs preserve an explicit message field", () => {
  const originalInfo = console.log;
  let captured = null;
  console.log = (line) => {
    captured = JSON.parse(line);
  };

  try {
    log.info({
      event: "custom_event",
      message: "keep this message",
      detail: "ok"
    });
  } finally {
    console.log = originalInfo;
  }

  assert.equal(captured.message, "keep this message");
  assert.equal(captured.detail, "ok");
});

test("failed request logs include error code and error message", async () => {
  const installId = "log-free-user";
  const token = await signInstallation(
    { installationId: installId, platform: "ios", issuedAt: Date.now() },
    env.INSTALLATION_TOKEN_SECRET
  );
  const captured = [];
  const originalWarn = console.warn;
  console.warn = (line) => {
    captured.push(JSON.parse(line));
  };

  try {
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
          body: JSON.stringify({ storyId: 12345, title: "Test", text: "Test content" })
        }),
        { ...env, DB: createDb() }
      );

      assert.equal(response.status, 402);
    });
  } finally {
    console.warn = originalWarn;
  }

  const requestLog = captured.find((entry) => entry.event === "request" && entry.route === "ai_summary");
  assert.equal(requestLog.errorCode, "pro_required");
  assert.equal(requestLog.errorMessage, "Pro subscription required");
  assert.match(requestLog.detailsSnippet, /pro_required/);
});

test("thrown response logs include response error details", async () => {
  const captured = [];
  const originalWarn = console.warn;
  console.warn = (line) => {
    captured.push(JSON.parse(line));
  };

  try {
    const response = await worker.fetch(
      new Request("https://example.com/v1/ai/summary", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ storyId: 12345 })
      }),
      env
    );

    assert.equal(response.status, 401);
  } finally {
    console.warn = originalWarn;
  }

  const requestLog = captured.find((entry) => entry.event === "request" && entry.route === "thrown_response");
  assert.equal(requestLog.errorMessage, "Missing or invalid installation token");
});

test("RevenueCat API request and response logs are emitted on success", async () => {
  const installId = "rc-log-success";
  const token = await signInstallation(
    { installationId: installId, platform: "ios", issuedAt: Date.now() },
    env.INSTALLATION_TOKEN_SECRET
  );
  const captured = [];
  const originalInfo = console.log;
  console.log = (line) => {
    captured.push(JSON.parse(line));
  };

  try {
    await withMockedFetch([
      {
        matchEnd: `customers/${installId}/virtual_currencies`,
        body: { object: "list", items: [{ object: "virtual_currency_balance", currency_code: "credit", balance: 123 }] }
      },
      {
        matchEnd: `customers/${installId}`,
        body: { object: "customer", id: installId, active_entitlements: { object: "list", items: [{ object: "customer.active_entitlement", entitlement_id: "entl3d830fd860", expires_at: null }] } }
      }
    ], async () => {
      const response = await worker.fetch(
        new Request("https://example.com/v1/credits", {
          headers: { authorization: `Bearer ${token}` }
        }),
        { ...env, DB: createDb() }
      );

      assert.equal(response.status, 200);
    });
  } finally {
    console.log = originalInfo;
  }

  const rcRequestEvents = captured.filter((entry) => entry.event === "rc_request");
  const rcResponseEvents = captured.filter((entry) => entry.event === "rc_response");
  assert.equal(rcRequestEvents.length, 2);
  assert.equal(rcResponseEvents.length, 2);
  assert.equal(rcRequestEvents[0].operation, "get_subscriber");
  assert.equal(rcRequestEvents[1].operation, "get_balance");
  assert.equal(rcResponseEvents[0].status, 200);
  assert.equal(rcResponseEvents[1].status, 200);
});

test("RevenueCat API response logs are emitted on failure", async () => {
  const installId = "rc-log-failure";
  const token = await signInstallation(
    { installationId: installId, platform: "ios", issuedAt: Date.now() },
    env.INSTALLATION_TOKEN_SECRET
  );
  const infoLogs = [];
  const warnLogs = [];
  const originalInfo = console.log;
  const originalWarn = console.warn;
  console.log = (line) => {
    infoLogs.push(JSON.parse(line));
  };
  console.warn = (line) => {
    warnLogs.push(JSON.parse(line));
  };

  try {
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
          body: JSON.stringify({ storyId: 12345, title: "Test", text: "Test content" })
        }),
        { ...env, DB: createDb() }
      );

      assert.equal(response.status, 503);
    });
  } finally {
    console.log = originalInfo;
    console.warn = originalWarn;
  }

  const rcRequestLog = infoLogs.find((entry) => entry.event === "rc_request" && entry.operation === "get_subscriber");
  const rcResponseLog = warnLogs.find((entry) => entry.event === "rc_response" && entry.operation === "get_subscriber");
  assert.equal(rcRequestLog.path, `/customers/${installId}`);
  assert.equal(rcResponseLog.status, 503);
  assert.match(rcResponseLog.responseSnippet, /temporarily unavailable/);
});
