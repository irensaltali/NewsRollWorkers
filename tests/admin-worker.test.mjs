import test from "node:test";
import assert from "node:assert/strict";

import adminWorker from "../src/admin-worker.mjs";

function createAdminDb() {
  let userId = 1;
  let templateId = 2;
  let runId = 1;
  let testResultId = 1;
  const adminUsers = new Map();
  const sessions = new Map();
  const auditLogs = [];
  const aiPrompts = new Map();
  const readableContentByStoryId = new Map();
  const promptTemplates = new Map([
    [1, {
      id: 1,
      name: "editorial_v1",
      description: "Default image prompt",
      templateText: 'Editorial illustration for "{{title}}". Context: {{sourceText}}',
      active: 1,
      modality: "image",
      provider: "openai",
      model: "gpt-image-1",
      settingsJson: JSON.stringify({ size: "1024x1024" }),
      createdBy: "seed",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }]
  ]);
  const promptRunEvents = [];
  const promptTestResults = [];

  return {
    readableContentByStoryId,
    prepare(sql) {
      const invocation = {
        bind(...args) {
          return {
            async first() {
              if (sql.includes("FROM admin_users")) {
                return adminUsers.get(args[0]) ?? null;
              }
              if (sql.includes("FROM admin_sessions s")) {
                return sessions.get(args[0]) ?? null;
              }
              if (sql.includes("FROM ai_prompt_configs") && sql.includes("WHERE key = ?1")) {
                return aiPrompts.get(args[0]) ?? null;
              }
              if (sql.includes("FROM story_content WHERE story_id = ?1")) {
                return readableContentByStoryId.get(Number(args[0])) ?? null;
              }
              if (sql.includes("FROM prompt_templates") && sql.includes("WHERE id = ?1")) {
                return promptTemplates.get(Number(args[0])) ?? null;
              }
              if (sql.includes("COUNT(*) AS totalRuns")) {
                return {
                  totalRuns: promptRunEvents.length,
                  succeeded: promptRunEvents.filter((item) => ["completed", "ready", "cached"].includes(item.status)).length,
                  failed: promptRunEvents.filter((item) => ["failed", "dead_letter"].includes(item.status)).length,
                  cacheHits: promptRunEvents.filter((item) => item.cache_hit === 1).length,
                  averageLatencyMs: 42
                };
              }
              if (sql.includes("INSERT INTO prompt_test_results")) {
                const row = {
                  id: testResultId++,
                  promptKind: args[0],
                  promptKey: args[1],
                  promptTemplateId: args[2],
                  provider: args[3],
                  model: args[4],
                  modality: args[5],
                  status: args[6],
                  latencyMs: args[7],
                  inputJson: args[8],
                  outputJson: args[9],
                  promptPreview: args[10],
                  artifactUrl: args[11],
                  errorText: args[12],
                  storyId: args[13],
                  hnUrl: args[14],
                  createdBy: args[15],
                  costUsd: args[16],
                  costCurrency: args[17],
                  costEstimated: args[18],
                  pricingSource: args[19],
                  costDetailsJson: args[20],
                  selected: 0,
                  notes: null,
                  createdAt: new Date().toISOString()
                };
                promptTestResults.push(row);
                return row;
              }
              return null;
            },
            async all() {
              if (sql.includes("FROM ai_prompt_configs")) {
                return { results: [...aiPrompts.values()] };
              }
              if (sql.includes("FROM prompt_templates")) {
                return { results: [...promptTemplates.values()] };
              }
              if (sql.includes("FROM prompt_run_events") && sql.includes("GROUP BY")) {
                return {
                  results: promptRunEvents.map((item) => ({
                    promptKind: item.prompt_kind,
                    promptKey: item.prompt_key,
                    provider: item.provider,
                    modality: item.modality,
                    totalRuns: 1,
                    succeeded: item.status === "ready" || item.status === "completed" ? 1 : 0,
                    failed: item.status === "failed" ? 1 : 0,
                    cacheHits: item.cache_hit,
                    averageLatencyMs: item.latency_ms,
                    lastRunAt: item.created_at
                  }))
                };
              }
              if (sql.includes("FROM prompt_run_events")) {
                return {
                  results: [...promptRunEvents]
                    .slice()
                    .reverse()
                    .slice(0, args[1] ?? 20)
                };
              }
              if (sql.includes("FROM prompt_test_results")) {
                return {
                  results: [...promptTestResults]
                    .slice()
                    .reverse()
                    .slice(0, args[args.length - 1] ?? 20)
                };
              }
              return { results: [] };
            },
            async run() {
              if (sql.includes("INSERT INTO story_content")) {
                readableContentByStoryId.set(Number(args[0]), {
                  extractedText: args[2]
                });
              }
              if (sql.includes("INSERT INTO admin_users")) {
                const [username, passwordSalt, passwordHash, active, updatedAt] = args;
                const existing = adminUsers.get(username);
                adminUsers.set(username, {
                  id: existing?.id ?? userId++,
                  username,
                  passwordSalt,
                  passwordHash,
                  active,
                  createdAt: existing?.createdAt ?? new Date().toISOString(),
                  updatedAt
                });
              }
              if (sql.includes("INSERT INTO admin_sessions")) {
                const [id, userIdValue, sessionHash, accessEmail, accessSubject, createdAt, expiresAt, lastSeenAt] = args;
                const user = [...adminUsers.values()].find((item) => item.id === userIdValue);
                sessions.set(sessionHash, {
                  id,
                  userId: userIdValue,
                  sessionHash,
                  accessEmail,
                  accessSubject,
                  createdAt,
                  expiresAt,
                  lastSeenAt,
                  username: user?.username ?? null,
                  userActive: user?.active ?? 1
                });
              }
              if (sql.includes("UPDATE admin_sessions")) {
                const session = sessions.get(args[0]);
                if (session) {
                  session.lastSeenAt = args[1];
                }
              }
              if (sql.includes("DELETE FROM admin_sessions")) {
                sessions.delete(args[0]);
              }
              if (sql.includes("INSERT INTO admin_audit_log")) {
                auditLogs.push(args);
              }
              if (sql.includes("INSERT INTO ai_prompt_configs")) {
                aiPrompts.set(args[0], {
                  key: args[0],
                  name: args[1],
                  provider: args[2],
                  model: args[3],
                  maxCompletionTokens: args[4],
                  systemPrompt: args[5],
                  userPromptTemplate: args[6],
                  settingsJson: args[7],
                  active: args[8],
                  updatedAt: args[9],
                  createdAt: new Date().toISOString()
                });
              }
              if (sql.includes("INSERT INTO prompt_templates")) {
                const id = sql.includes("VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)")
                  ? templateId++
                  : Number(args[0]);
                promptTemplates.set(id, {
                  id,
                  name: sql.includes("UPDATE prompt_templates") ? args[1] : args[0],
                  description: sql.includes("UPDATE prompt_templates") ? args[2] : args[1],
                  templateText: sql.includes("UPDATE prompt_templates") ? args[3] : args[2],
                  active: sql.includes("UPDATE prompt_templates") ? args[4] : args[3],
                  modality: sql.includes("UPDATE prompt_templates") ? args[5] : args[4],
                  provider: sql.includes("UPDATE prompt_templates") ? args[6] : args[5],
                  model: sql.includes("UPDATE prompt_templates") ? args[7] : args[6],
                  settingsJson: sql.includes("UPDATE prompt_templates") ? args[8] : args[7],
                  createdBy: sql.includes("UPDATE prompt_templates") ? args[9] : args[8],
                  updatedAt: sql.includes("UPDATE prompt_templates") ? args[10] : args[10],
                  createdAt: new Date().toISOString()
                });
                return { meta: { last_row_id: id } };
              }
              if (sql.includes("UPDATE prompt_templates")) {
                const id = Number(args[0]);
                const current = promptTemplates.get(id);
                promptTemplates.set(id, {
                  ...current,
                  id,
                  name: args[1],
                  description: args[2],
                  templateText: args[3],
                  active: args[4],
                  modality: args[5],
                  provider: args[6],
                  model: args[7],
                  settingsJson: args[8],
                  createdBy: args[9] ?? current?.createdBy ?? null,
                  updatedAt: args[10]
                });
              }
              if (sql.includes("INSERT INTO prompt_run_events")) {
                promptRunEvents.push({
                  id: runId++,
                  source: args[0],
                  prompt_kind: args[1],
                  prompt_key: args[2],
                  prompt_template_id: args[3],
                  provider: args[4],
                  model: args[5],
                  modality: args[6],
                  status: args[7],
                  latency_ms: args[8],
                  cache_hit: args[9],
                  request_excerpt: args[10],
                  response_excerpt: args[11],
                  artifact_url: args[12],
                  error_text: args[13],
                  story_id: args[14],
                  cost_usd: args[15],
                  cost_currency: args[16],
                  cost_estimated: args[17],
                  pricing_source: args[18],
                  cost_details_json: args[19],
                  created_at: args[20]
                });
              }
              return { meta: { changes: 1 } };
            }
          };
        }
      };
      invocation.first = async () => invocation.bind().first();
      invocation.all = async () => invocation.bind().all();
      invocation.run = async () => invocation.bind().run();
      return invocation;
    }
  };
}

function env(overrides = {}) {
  return {
    ENVIRONMENT: "test",
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD: "secret",
    OPENAI_API_KEY: "sk-test",
    DB: createAdminDb(),
    ...overrides
  };
}

test("admin worker requires a valid admin session for protected routes", async () => {
  const response = await adminWorker.fetch(
    new Request("https://admin.newsroll.com/api/prompts"),
    env()
  );

  assert.equal(response.status, 401);
});

test("admin worker login establishes a session and session endpoint sees it", async () => {
  const testEnv = env();
  const login = await adminWorker.fetch(
    new Request("https://admin.newsroll.com/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "secret" })
    }),
    testEnv
  );

  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie");
  assert.ok(cookie?.includes("hr_admin_session="));

  const session = await adminWorker.fetch(
    new Request("https://admin.newsroll.com/api/auth/session", {
      headers: { cookie }
    }),
    testEnv
  );

  assert.equal(session.status, 200);
  const payload = await session.json();
  assert.equal(payload.authenticated, true);
  assert.equal(payload.user.username, "admin");
});

test("admin worker echoes allowed preview origins for credentialed requests", async () => {
  const response = await adminWorker.fetch(
    new Request("https://admin-staging.newsroll.com/api/auth/session", {
      headers: {
        origin: "https://newsrolladmin.pages.dev"
      }
    }),
    env()
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "https://newsrolladmin.pages.dev");
  assert.equal(response.headers.get("access-control-allow-credentials"), "true");
  assert.match(response.headers.get("vary") ?? "", /Origin/);
});

test("admin worker handles allowed preflight requests", async () => {
  const response = await adminWorker.fetch(
    new Request("https://admin-staging.newsroll.com/api/auth/session", {
      method: "OPTIONS",
      headers: {
        origin: "https://newsrolladmin.pages.dev"
      }
    }),
    env()
  );

  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "https://newsrolladmin.pages.dev");
  assert.equal(response.headers.get("access-control-allow-credentials"), "true");
  assert.equal(response.headers.get("access-control-allow-methods"), "GET, POST, PUT, OPTIONS");
});

test("admin worker updates AI prompts and exposes prompt listing", async () => {
  const testEnv = env();
  const login = await adminWorker.fetch(
    new Request("https://admin.newsroll.com/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "secret" })
    }),
    testEnv
  );
  const cookie = login.headers.get("set-cookie");

  const update = await adminWorker.fetch(
    new Request("https://admin.newsroll.com/api/prompts/ai/summary", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        cookie
      },
      body: JSON.stringify({
        model: "o4-mini",
        systemPrompt: "Summarize clearly",
        userPromptTemplate: "Title: {{title}}"
      })
    }),
    testEnv
  );

  assert.equal(update.status, 200);

  const prompts = await adminWorker.fetch(
    new Request("https://admin.newsroll.com/api/prompts", {
      headers: { cookie }
    }),
    testEnv
  );
  const payload = await prompts.json();
  assert.equal(prompts.status, 200);
  assert.equal(Array.isArray(payload.aiFeatures), true);
  assert.equal(payload.aiFeatures.find((feature) => feature.key === "translation")?.usesTargetLanguage, true);
  assert.equal(Array.isArray(payload.aiPrompts), true);
  assert.equal(Array.isArray(payload.mediaPrompts), true);
});

test("admin worker exposes a dynamic model catalog with pricing", async () => {
  const testEnv = env({ FAL_API_KEY: "fal-test" });
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === "https://api.openai.com/v1/models") {
      return Response.json({
        data: [
          { id: "o4-mini" },
          { id: "o1-mini" },
          { id: "gpt-image-1" },
          { id: "sora-2" }
        ]
      });
    }
    if (url.startsWith("https://api.fal.ai/v1/models?")) {
      return Response.json({
        models: [
          { endpoint_id: "fal-ai/flux-2/turbo", display_name: "FLUX.2 Turbo", status: "active" },
          { endpoint_id: "fal-ai/sora-2/text-to-video", display_name: "Sora 2 Video", status: "active" }
        ]
      });
    }
    if (url.startsWith("https://api.fal.ai/v1/models/pricing?")) {
      return Response.json({
        prices: [
          { endpoint_id: "fal-ai/flux-2/turbo", unit_price: 0.025, unit: "image", currency: "USD" },
          { endpoint_id: "fal-ai/sora-2/text-to-video", unit_price: 0.1, unit: "video", currency: "USD" }
        ]
      });
    }

    return originalFetch(input);
  };

  try {
    const login = await adminWorker.fetch(
      new Request("https://admin.newsroll.com/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "secret" })
      }),
      testEnv
    );
    const cookie = login.headers.get("set-cookie");

    const response = await adminWorker.fetch(
      new Request("https://admin.newsroll.com/api/model-catalog", {
        headers: { cookie }
      }),
      testEnv
    );

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.providers.openai.text[0].id, "o4-mini");
    assert.equal(payload.providers.fal.image[0].label, "FLUX.2 Turbo");
    assert.equal(payload.providers.fal.image[0].pricing.display, "$0.0250 / image");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("admin worker runs AI tests with a temporary prompt override", async () => {
  const testEnv = env();
  const originalFetch = globalThis.fetch;
  let openAIRequest = null;

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === "https://api.openai.com/v1/chat/completions") {
      openAIRequest = JSON.parse(init.body);
      return Response.json({
        usage: {
          prompt_tokens: 120,
          completion_tokens: 30,
          prompt_tokens_details: {
            cached_tokens: 20
          }
        },
        choices: [
          {
            message: {
              content: JSON.stringify({ bullets: ["Draft bullet one", "Draft bullet two"] })
            }
          }
        ]
      });
    }

    return originalFetch(input, init);
  };

  try {
    const login = await adminWorker.fetch(
      new Request("https://admin.newsroll.com/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "secret" })
      }),
      testEnv
    );
    const cookie = login.headers.get("set-cookie");

    const response = await adminWorker.fetch(
      new Request("https://admin.newsroll.com/api/test/ai", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie
        },
        body: JSON.stringify({
          promptKey: "summary",
          title: "Prompt override test",
          text: "Article body",
          promptConfig: {
            systemPrompt: "Temporary system prompt",
            userPromptTemplate: "Draft summary for {{title}}"
          }
        })
      }),
      testEnv
    );

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.promptPreview, "Draft summary for Prompt override test");
    assert.equal(payload.result, "• Draft bullet one\n• Draft bullet two");
    assert.equal(payload.costEstimated, false);
    assert.equal(payload.pricingSource, "openai_static_registry");
    assert.equal(payload.costUsd > 0, true);
    assert.equal(openAIRequest?.messages?.[0]?.content, "Temporary system prompt");
    assert.equal(openAIRequest?.messages?.[1]?.content, "Draft summary for Prompt override test");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("admin worker AI summary test uses provided text when available", async () => {
  const testEnv = env();
  const originalFetch = globalThis.fetch;
  let openAIRequest = null;

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === "https://api.openai.com/v1/chat/completions") {
      openAIRequest = JSON.parse(init.body);
      return Response.json({
        usage: {
          prompt_tokens: 120,
          completion_tokens: 30,
          prompt_tokens_details: { cached_tokens: 0 }
        },
        choices: [{ message: { content: JSON.stringify({ bullets: ["Summary result"] }) } }]
      });
    }
    return originalFetch(input, init);
  };

  try {
    const login = await adminWorker.fetch(
      new Request("https://admin.newsroll.com/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "secret" })
      }),
      testEnv
    );
    const cookie = login.headers.get("set-cookie");

    const response = await adminWorker.fetch(
      new Request("https://admin.newsroll.com/api/test/ai", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          promptKey: "summary",
          storyId: 47487436,
          title: "Migrating to the EU",
          text: "Provided article text for summary."
        })
      }),
      testEnv
    );

    assert.equal(response.status, 200);
    assert.match(openAIRequest?.messages?.[1]?.content ?? "", /Provided article text for summary\./);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("admin worker runs an image test and includes the run in stats", async () => {
  const testEnv = env({ FAL_API_KEY: "fal-test" });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === "https://api.openai.com/v1/images/generations") {
      return Response.json({
        data: [{ url: "https://cdn.example.com/generated.png" }]
      });
    }
    if (url === "https://api.openai.com/v1/models") {
      return Response.json({
        data: [
          { id: "o4-mini" },
          { id: "o1-mini" },
          { id: "gpt-image-1" },
          { id: "sora-2" }
        ]
      });
    }
    if (url.startsWith("https://api.fal.ai/v1/models?")) {
      return Response.json({
        models: [
          { endpoint_id: "fal-ai/flux-2/turbo", display_name: "FLUX.2 Turbo", status: "active" },
          { endpoint_id: "fal-ai/sora-2/text-to-video", display_name: "Sora 2 Video", status: "active" }
        ]
      });
    }
    if (url.startsWith("https://api.fal.ai/v1/models/pricing?")) {
      return Response.json({
        prices: [
          { endpoint_id: "fal-ai/flux-2/turbo", unit_price: 0.025, unit: "image", currency: "USD" },
          { endpoint_id: "fal-ai/sora-2/text-to-video", unit_price: 0.1, unit: "video", currency: "USD" }
        ]
      });
    }
    return originalFetch(input);
  };

  try {
    const login = await adminWorker.fetch(
      new Request("https://admin.newsroll.com/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "secret" })
      }),
      testEnv
    );
    const cookie = login.headers.get("set-cookie");

    const imageTest = await adminWorker.fetch(
      new Request("https://admin.newsroll.com/api/test/image", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie
        },
        body: JSON.stringify({
          templateId: 1,
          title: "Test story",
          sourceText: "Compiler improvements and infrastructure details."
        })
      }),
      testEnv
    );

    assert.equal(imageTest.status, 200);
    const imagePayload = await imageTest.json();
    assert.equal(imagePayload.assetUrl, "https://cdn.example.com/generated.png");
    assert.equal(imagePayload.costDisplay, "~$0.0420");
    assert.equal(imagePayload.costEstimated, true);

    const overview = await adminWorker.fetch(
      new Request("https://admin.newsroll.com/api/stats/overview", {
        headers: { cookie }
      }),
      testEnv
    );
    const statsPayload = await overview.json();
    assert.equal(overview.status, 200);
    assert.equal(statsPayload.overview.totalRuns, 1);
    assert.equal(statsPayload.recentRuns.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
