import {
  createAdminAuditLog,
  createPromptRunEvent,
  createPromptTestResult,
  getAdminUserByUsername,
  getAIPromptConfig,
  getActivePromptTemplate,
  getPromptRunOverview,
  getPromptRunStats,
  getPromptTemplateById,
  listAIPromptConfigs,
  listPromptRunEvents,
  listPromptTemplates,
  listPromptTestResults,
  selectPromptTestResult,
  updatePromptTestResultNotes,
  upsertAIPromptConfig,
  upsertPromptTemplate,
  getRSSSources,
  getRSSSourceById,
  upsertRSSSource,
  setRSSSourceActive
} from "./db.mjs";
import { ingestSource } from "./rss-ingest.mjs";
import { error, json, readJson } from "./http.mjs";
import {
  attachAdminSessionCookie,
  clearAdminSessionCookie,
  createAuthenticatedAdminSession,
  destroyAuthenticatedAdminSession,
  getAuthenticatedAdmin,
  syncAdminSeedUser,
  verifyAdminPassword
} from "./admin-auth.mjs";
import { buildHeadlineRequest, generateHeadline } from "./summary.mjs";
import {
  formatExplainResult,
  generateExplain,
  generateExplainViaCrawl,
  generateStructuredTranslation,
  generateSummary,
  generateSummaryViaCrawl,
  generateThreadIntelligence
} from "./ai-gateway.mjs";
import { buildPromptInput, clipPromptText, promptConfigWithFallback, mediaTemplateWithFallback, getDefaultUserPromptForProvider } from "./prompt-config.mjs";
import { generateImageWithProvider, generateVideoWithProvider, proxyOpenAIVideoContent } from "./media-generation.mjs";
// TODO: Replace with multi-source fetch when source adapters are implemented
async function fetchItem(_id) { return null; }

// ── RSS source handlers ───────────────────────────────────────────────────────

async function handleListRSSSources(request, env) {
  await requireAdmin(request, env);
  const url = new URL(request.url);
  const category = url.searchParams.get("category") ?? null;
  const sources = await getRSSSources(env, { category, activeOnly: false });
  return json({ ok: true, sources });
}

async function handleCreateRSSSource(request, env) {
  await requireAdmin(request, env);
  const body = await readJson(request);
  if (!body?.name || !body?.feed_url || !body?.category) {
    return error("name, feed_url, and category are required", 400);
  }
  const id = await upsertRSSSource(env, body);
  await createAdminAuditLog(env, { action: "rss_source_create", detail: JSON.stringify({ id, name: body.name }) });
  return json({ ok: true, id }, 201);
}

async function handleUpdateRSSSource(request, env, id) {
  await requireAdmin(request, env);
  const source = await getRSSSourceById(env, Number(id));
  if (!source) return error("RSS source not found", 404);
  const body = await readJson(request);
  await upsertRSSSource(env, { ...source, ...body, id: Number(id) });
  await createAdminAuditLog(env, { action: "rss_source_update", detail: JSON.stringify({ id }) });
  return json({ ok: true });
}

async function handleDeleteRSSSource(request, env, id) {
  await requireAdmin(request, env);
  const source = await getRSSSourceById(env, Number(id));
  if (!source) return error("RSS source not found", 404);
  await setRSSSourceActive(env, Number(id), false);
  await createAdminAuditLog(env, { action: "rss_source_deactivate", detail: JSON.stringify({ id }) });
  return json({ ok: true });
}

async function handleFetchRSSSource(request, env, id) {
  await requireAdmin(request, env);
  const source = await getRSSSourceById(env, Number(id));
  if (!source) return error("RSS source not found", 404);
  const result = await ingestSource(env, source);
  return json({ ok: true, ...result });
}
import { resolveArticleContent, resolveArticleUrl } from "./article-content.mjs";
import { listAIFeatures } from "./ai-feature-config.mjs";
import * as log from "./log.mjs";
import {
  calculateFalMediaCost,
  calculateOpenAIImageCost,
  calculateOpenAITextCost,
  calculateOpenAIVideoCost,
  getAdminModelCatalog,
  mergeOpenAIUsages
} from "./model-catalog.mjs";

function adminApiPath(pathname) {
  return pathname.startsWith("/api/") ? pathname.slice("/api".length) || "/" : pathname;
}

const ADMIN_CORS_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
const ADMIN_CORS_HEADERS = "Content-Type";
const ADMIN_CORS_MAX_AGE = "86400";
const ALLOWED_ADMIN_ORIGIN_PATTERNS = [
  /^https:\/\/admin\.newsroll\.com$/i,
  /^https:\/\/admin-staging\.newsroll\.com$/i,
  /^https:\/\/([a-z0-9-]+\.)?pages\.dev$/i,
  /^http:\/\/localhost(?::\d+)?$/i,
  /^https:\/\/localhost(?::\d+)?$/i
];

function resolveAllowedOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin) {
    return null;
  }
  return ALLOWED_ADMIN_ORIGIN_PATTERNS.some((pattern) => pattern.test(origin)) ? origin : null;
}

function appendVary(headers, value) {
  const existing = headers.get("vary");
  if (!existing) {
    headers.set("vary", value);
    return;
  }

  const values = existing
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (!values.includes(value.toLowerCase())) {
    headers.set("vary", `${existing}, ${value}`);
  }
}

function withAdminCors(request, response) {
  const origin = resolveAllowedOrigin(request);
  if (!origin) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set("access-control-allow-credentials", "true");
  headers.set("access-control-allow-methods", ADMIN_CORS_METHODS);
  headers.set("access-control-allow-headers", ADMIN_CORS_HEADERS);
  headers.set("access-control-max-age", ADMIN_CORS_MAX_AGE);
  appendVary(headers, "Origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function handlePreflight(request) {
  if (!resolveAllowedOrigin(request)) {
    return error("Origin not allowed", 403);
  }
  return withAdminCors(request, new Response(null, { status: 204 }));
}

function daysFromUrl(url) {
  const days = Number.parseInt(url.searchParams.get("days") ?? "30", 10);
  return Number.isFinite(days) && days > 0 ? Math.min(days, 180) : 30;
}

function sanitizeSettings(value) {
  return value && typeof value === "object" ? value : {};
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function resolveAIPromptConfig(basePromptConfig, override = null) {
  if (!override || typeof override !== "object") {
    return basePromptConfig;
  }

  return promptConfigWithFallback({
    ...basePromptConfig,
    key: basePromptConfig.key,
    name: String(override.name ?? basePromptConfig.name).trim() || basePromptConfig.name,
    provider: String(override.provider ?? basePromptConfig.provider ?? "openai").trim() || (basePromptConfig.provider ?? "openai"),
    model: String(override.model ?? basePromptConfig.model ?? "").trim() || basePromptConfig.model,
    maxCompletionTokens: Number(override.maxCompletionTokens ?? basePromptConfig.maxCompletionTokens ?? 0) || basePromptConfig.maxCompletionTokens,
    systemPrompt: String(override.systemPrompt ?? basePromptConfig.systemPrompt),
    userPromptTemplate: String(override.userPromptTemplate ?? basePromptConfig.userPromptTemplate),
    settings: sanitizeSettings(override.settings ?? basePromptConfig.settings),
    active: override.active ?? basePromptConfig.active
  }, basePromptConfig.key);
}

function stringifyPreview(value, maxLength = 1200) {
  if (value == null) {
    return null;
  }
  return String(typeof value === "string" ? value : JSON.stringify(value)).slice(0, maxLength);
}

async function requireAdmin(request, env) {
  const admin = await getAuthenticatedAdmin(request, env);
  if (!admin) {
    throw error("Unauthorized", 401);
  }
  return { admin };
}

async function handleSession(request, env) {
  const admin = await getAuthenticatedAdmin(request, env);
  if (!admin) {
    return json({ authenticated: false });
  }

  return json({
    authenticated: true,
    user: {
      username: admin.username
    }
  });
}

async function handleLogin(request, env) {
  await syncAdminSeedUser(env);

  const body = (await readJson(request)) ?? {};
  const username = String(body.username ?? "").trim();
  const password = String(body.password ?? "");
  if (!username || !password) {
    return error("username and password are required", 422);
  }

  const user = await getAdminUserByUsername(env, username);
  if (!user || Number(user.active ?? 0) !== 1) {
    return error("Invalid credentials", 401);
  }

  const valid = await verifyAdminPassword(password, user);
  if (!valid) {
    return error("Invalid credentials", 401);
  }

  const session = await createAuthenticatedAdminSession(env, user);
  return attachAdminSessionCookie(
    json({
      authenticated: true,
      user: {
        username: user.username
      }
    }),
    session
  );
}

async function handleLogout(request, env) {
  await destroyAuthenticatedAdminSession(request, env);
  return clearAdminSessionCookie(json({ ok: true }));
}

async function handlePrompts(request, env) {
  await requireAdmin(request, env);
  return json({
    aiFeatures: listAIFeatures(),
    aiPrompts: await listAIPromptConfigs(env),
    mediaPrompts: await listPromptTemplates(env)
  });
}

async function handleModelCatalog(request, env) {
  await requireAdmin(request, env);
  return json(await getAdminModelCatalog(env));
}

async function handleUpdateAIPrompt(request, env, key) {
  const { admin } = await requireAdmin(request, env);
  const body = (await readJson(request)) ?? {};
  const existing = promptConfigWithFallback(await getAIPromptConfig(env, key), key);
  if (!existing) {
    return error("Unknown prompt key", 404);
  }

  const updated = await upsertAIPromptConfig(env, {
    key,
    name: String(body.name ?? existing.name).trim(),
    provider: String(body.provider ?? existing.provider ?? "openai").trim() || "openai",
    model: String(body.model ?? existing.model).trim() || existing.model,
    maxCompletionTokens: Number(body.maxCompletionTokens ?? existing.maxCompletionTokens ?? 0) || existing.maxCompletionTokens,
    systemPrompt: String(body.systemPrompt ?? existing.systemPrompt),
    userPromptTemplate: String(body.userPromptTemplate ?? existing.userPromptTemplate),
    settings: sanitizeSettings(body.settings ?? existing.settings),
    active: body.active ?? existing.active
  });

  await createAdminAuditLog(env, {
    userId: admin.userId,
    username: admin.username,
    action: "ai_prompt_updated",
    targetType: "ai_prompt",
    targetId: key,
    detailsJson: JSON.stringify({ provider: updated.provider, model: updated.model })
  });

  return json({ prompt: updated });
}

async function handleCreateMediaPrompt(request, env) {
  const { admin } = await requireAdmin(request, env);
  const body = (await readJson(request)) ?? {};
  const prompt = await upsertPromptTemplate(env, {
    name: String(body.name ?? "").trim(),
    description: body.description ?? null,
    templateText: String(body.templateText ?? ""),
    active: body.active !== false,
    modality: body.modality === "video" ? "video" : "image",
    provider: String(body.provider ?? "fal").trim() || "fal",
    model: String(body.model ?? "").trim() || null,
    settings: sanitizeSettings(body.settings),
    createdBy: admin.username
  });

  await createAdminAuditLog(env, {
    userId: admin.userId,
    username: admin.username,
    action: "media_prompt_created",
    targetType: "media_prompt",
    targetId: String(prompt.id)
  });

  return json({ prompt }, { status: 201 });
}

async function handleUpdateMediaPrompt(request, env, templateId) {
  const { admin } = await requireAdmin(request, env);
  const current = await getPromptTemplateById(env, Number(templateId));
  if (!current) {
    return error("Prompt template not found", 404);
  }

  const body = (await readJson(request)) ?? {};
  const updated = await upsertPromptTemplate(env, {
    id: Number(templateId),
    name: String(body.name ?? current.name).trim(),
    description: body.description ?? current.description ?? null,
    templateText: String(body.templateText ?? current.templateText),
    active: body.active ?? current.active,
    modality: body.modality ?? current.modality,
    provider: String(body.provider ?? current.provider ?? "fal").trim() || current.provider,
    model: String(body.model ?? current.model ?? "").trim() || null,
    settings: sanitizeSettings(body.settings ?? current.settings),
    createdBy: admin.username
  });

  await createAdminAuditLog(env, {
    userId: admin.userId,
    username: admin.username,
    action: "media_prompt_updated",
    targetType: "media_prompt",
    targetId: String(templateId),
    detailsJson: JSON.stringify({ provider: updated.provider, modality: updated.modality })
  });

  return json({ prompt: updated });
}

async function handleOverview(request, env) {
  await requireAdmin(request, env);
  const url = new URL(request.url);
  const days = daysFromUrl(url);
  return json({
    days,
    overview: await getPromptRunOverview(env, { days }),
    recentRuns: await listPromptRunEvents(env, { days, limit: 20 })
  });
}

async function handlePromptStats(request, env) {
  await requireAdmin(request, env);
  const url = new URL(request.url);
  const days = daysFromUrl(url);
  return json({
    days,
    stats: await getPromptRunStats(env, { days })
  });
}

async function buildAiPreview(promptKey, payload, promptConfig) {
  switch (promptKey) {
    case "headline": {
      const request = await buildHeadlineRequest(
        { DB: null },
        payload.title ?? "",
        payload.text ?? "",
        { promptConfig }
      );
      return request.messages[1]?.content ?? null;
    }
    case "summary":
      return buildPromptInput(promptConfig.userPromptTemplate, {
        title: payload.title ?? "",
        text: clipPromptText(payload.text ?? "", 4000)
      });
    case "translation":
      return buildPromptInput(promptConfig.userPromptTemplate, {
        targetLanguage: payload.targetLanguage ?? "",
        payload: JSON.stringify(payload.translationPayload ?? {})
      });
    case "thread_intelligence":
    case "explain_simple":
    case "explain_technical":
      return buildPromptInput(promptConfig.userPromptTemplate, {
        payload: JSON.stringify(payload.promptPayload ?? {})
      });
    default:
      return null;
  }
}

function enrichTestPayloadWithCost(payload, cost) {
  return {
    ...payload,
    ...cost
  };
}

async function calculateMediaCost(env, payload, result) {
  const catalog = await getAdminModelCatalog(env);
  if (payload.provider === "openai") {
    return payload.modality === "video"
      ? calculateOpenAIVideoCost(payload.model, result.requestSettings ?? payload.settings)
      : calculateOpenAIImageCost(payload.model, result.requestSettings ?? payload.settings);
  }

  return calculateFalMediaCost(catalog, {
    model: payload.model,
    modality: payload.modality,
    settings: payload.settings,
    billableUnits: result.billableUnits ?? null
  });
}

async function handleAITest(request, env) {
  const { admin } = await requireAdmin(request, env);
  const body = (await readJson(request)) ?? {};
  const promptKey = String(body.promptKey ?? "").trim();
  const storedPromptConfig = promptConfigWithFallback(await getAIPromptConfig(env, promptKey), promptKey);
  const promptConfig = resolveAIPromptConfig(storedPromptConfig, body.promptConfig);
  if (!promptConfig) {
    return error("Unknown prompt key", 404);
  }
  const isCloudflareCrawlProvider = promptConfig.provider === "cloudflare";
  const crawlSupportedKeys = ["summary", "explain_simple", "explain_technical"];
  if (promptConfig.provider !== "openai" && !(isCloudflareCrawlProvider && crawlSupportedKeys.includes(promptKey))) {
    return error(`Provider "${promptConfig.provider}" is not supported for prompt key "${promptKey}"`, 422);
  }

  const startedAt = Date.now();
  let result = null;
  let previewPayload = {};
  let openAIUsage = null;

  switch (promptKey) {
    case "headline":
      result = await generateHeadline(env, {
        storyId: Number(body.storyId ?? 0),
        title: body.title ?? "",
        extractedText: body.text ?? ""
      }, { promptConfig, includeMeta: true });
      previewPayload = { title: body.title ?? "", text: body.text ?? "" };
      openAIUsage = result?.usage ?? null;
      result = result?.headline ?? null;
      break;
    case "summary": {
      const storyId = Number(body.storyId ?? 0);
      const title = body.title ?? "";

      if (isCloudflareCrawlProvider) {
        const articleUrl = await resolveArticleUrl(env, storyId, { url: body.url ?? null });
        if (articleUrl) {
          result = await generateSummaryViaCrawl(env, articleUrl, storyId, title, { promptConfig, includeMeta: true });
          previewPayload = { title, url: articleUrl, provider: "cloudflare" };
          openAIUsage = result?.usage ?? null;
          result = result?.result ?? null;
        } else {
          log.info({ event: "admin_provider_fallback", provider: "cloudflare", fallback: "openai", reason: "no_url", storyId });
          const article = await resolveArticleContent(env, storyId, { title, text: body.text ?? "", url: null });
          const summaryTitle = article.title || title;
          result = await generateSummary(env, storyId, summaryTitle, article.text, { promptConfig, includeMeta: true });
          previewPayload = { title: summaryTitle, text: article.text, provider: "openai (fallback)" };
          openAIUsage = result?.usage ?? null;
          result = result?.result ?? null;
        }
      } else {
        const article = await resolveArticleContent(env, storyId, { title, text: body.text ?? "", url: body.url ?? null });
        const summaryTitle = article.title || title;
        result = await generateSummary(env, storyId, summaryTitle, article.text, { promptConfig, includeMeta: true });
        previewPayload = { title: summaryTitle, text: article.text };
        openAIUsage = result?.usage ?? null;
        result = result?.result ?? null;
      }
      break;
    }
    case "translation": {
      const article = await resolveArticleContent(env, Number(body.storyId ?? 0), {
        title: body.title ?? "",
        text: body.text ?? "",
        url: body.url ?? null
      });
      const translationPayload = {
        storyId: Number(body.storyId ?? 0),
        targetLanguage: body.targetLanguage ?? "English",
        story: {
          id: Number(body.storyId ?? 0),
          title: article.title || (body.title ?? ""),
          text: article.text
        },
        comments: body.comments ?? []
      };
      result = await generateStructuredTranslation(env, translationPayload, { promptConfig, includeMeta: true });
      previewPayload = { targetLanguage: translationPayload.targetLanguage, translationPayload };
      openAIUsage = mergeOpenAIUsages(...(result?.usages ?? []));
      result = result?.result ?? null;
      break;
    }
    case "thread_intelligence": {
      const promptPayload = {
        storyId: Number(body.storyId ?? 0),
        title: body.title ?? "",
        comments: body.comments ?? []
      };
      result = await generateThreadIntelligence(env, promptPayload, { promptConfig, includeMeta: true });
      previewPayload = { promptPayload };
      openAIUsage = result?.usage ?? null;
      result = result?.result ?? null;
      break;
    }
    case "explain_simple":
    case "explain_technical": {
      const storyId = Number(body.storyId ?? 0);
      const level = promptKey === "explain_simple" ? "simple" : "technical";

      if (isCloudflareCrawlProvider) {
        const articleUrl = await resolveArticleUrl(env, storyId, { url: body.url ?? null });
        if (articleUrl) {
          result = await generateExplainViaCrawl(env, articleUrl, storyId, body.title ?? "", level, { promptConfig, includeMeta: true });
          previewPayload = { title: body.title ?? "", url: articleUrl, level, provider: "cloudflare" };
          openAIUsage = result?.usage ?? null;
          result = result?.result ? {
            ...result.result,
            formatted: formatExplainResult(result.result)
          } : null;
        } else {
          log.info({ event: "admin_provider_fallback", provider: "cloudflare", fallback: "openai", reason: "no_url", storyId });
          const article = await resolveArticleContent(env, storyId, { title: body.title ?? "", text: body.text ?? "", url: null });
          const promptPayload = { storyId, title: article.title || (body.title ?? ""), text: article.text, level };
          result = await generateExplain(env, promptPayload, { promptConfig, includeMeta: true });
          previewPayload = { promptPayload, provider: "openai (fallback)" };
          openAIUsage = result?.usage ?? null;
          result = result?.result ? { ...result.result, formatted: formatExplainResult(result.result) } : null;
        }
      } else {
        const article = await resolveArticleContent(env, storyId, { title: body.title ?? "", text: body.text ?? "", url: body.url ?? null });
        const promptPayload = { storyId, title: article.title || (body.title ?? ""), text: article.text, level };
        result = await generateExplain(env, promptPayload, { promptConfig, includeMeta: true });
        previewPayload = { promptPayload };
        openAIUsage = result?.usage ?? null;
        result = result?.result ? { ...result.result, formatted: formatExplainResult(result.result) } : null;
      }
      break;
    }
    default:
      return error("Unsupported prompt key", 422);
  }

  const promptPreview = await buildAiPreview(promptKey, previewPayload, promptConfig);
  const latencyMs = Date.now() - startedAt;
  const status = result ? "completed" : "failed";
  const cost = calculateOpenAITextCost(promptConfig.model, openAIUsage);
  await createPromptRunEvent(env, {
    source: "admin",
    promptKind: "ai",
    promptKey,
    provider: promptConfig.provider,
    model: promptConfig.model,
    modality: "text",
    status,
    latencyMs,
    requestExcerpt: stringifyPreview(promptPreview),
    responseExcerpt: stringifyPreview(result),
    errorText: result ? null : "AI test failed",
    storyId: body.storyId ?? null,
    cost
  });

  await createAdminAuditLog(env, {
    userId: admin.userId,
    username: admin.username,
    action: "ai_prompt_tested",
    targetType: "ai_prompt",
    targetId: promptKey
  });

  const testResult = await createPromptTestResult(env, {
    promptKind: "ai",
    promptKey,
    provider: promptConfig.provider,
    model: promptConfig.model,
    modality: "text",
    status,
    latencyMs,
    inputJson: JSON.stringify({
      promptKey,
      storyId: body.storyId ?? null,
      title: body.title ?? "",
      text: body.text ?? "",
      comments: body.comments ?? [],
      targetLanguage: body.targetLanguage ?? null
    }),
    outputJson: result ? JSON.stringify(result) : null,
    promptPreview: stringifyPreview(promptPreview),
    errorText: result ? null : "AI test failed",
    storyId: body.storyId ?? null,
    hnUrl: body.hnUrl ?? null,
    createdBy: admin.username,
    cost
  });

  if (!result) {
    return json(enrichTestPayloadWithCost({
      promptKey,
      provider: promptConfig.provider,
      model: promptConfig.model,
      promptPreview,
      latencyMs,
      result: null,
      status: "failed",
      errorText: "AI test failed",
      testResultId: testResult?.id ?? null
    }, cost), { status: 200 });
  }

  return json(enrichTestPayloadWithCost({
    promptKey,
    provider: promptConfig.provider,
    model: promptConfig.model,
    promptPreview,
    latencyMs,
    status: "completed",
    result,
    testResultId: testResult?.id ?? null
  }, cost));
}

async function resolveMediaPrompt(body, modality, env) {
  const template = body.templateId
    ? await getPromptTemplateById(env, Number(body.templateId))
    : await getActivePromptTemplate(env, { modality, provider: body.provider ?? null });
  const normalizedTemplate = mediaTemplateWithFallback(template, modality);
  const prompt = String(body.prompt ?? "").trim() || buildPromptInput(normalizedTemplate.templateText, {
    title: body.title ?? "Untitled story",
    sourceText: clipPromptText(body.sourceText ?? body.text ?? "", 1200)
  });

  return {
    template: normalizedTemplate,
    prompt,
    provider: String(body.provider ?? normalizedTemplate.provider ?? "fal"),
    model: String(body.model ?? normalizedTemplate.model ?? "").trim() || normalizedTemplate.model,
    settings: sanitizeSettings(body.settings ?? normalizedTemplate.settings)
  };
}

async function handleImageTest(request, env) {
  const { admin } = await requireAdmin(request, env);
  const body = (await readJson(request)) ?? {};
  const promptData = await resolveMediaPrompt(body, "image", env);

  const startedAt = Date.now();
  const result = await generateImageWithProvider(env, {
    provider: promptData.provider,
    model: promptData.model,
    settings: promptData.settings,
    prompt: promptData.prompt
  });
  const latencyMs = Date.now() - startedAt;
  const cost = await calculateMediaCost(env, {
    provider: promptData.provider,
    model: promptData.model,
    modality: "image",
    settings: promptData.settings
  }, result);

  await createPromptRunEvent(env, {
    source: "admin",
    promptKind: "media",
    promptKey: promptData.template.name,
    promptTemplateId: promptData.template.id,
    provider: result.provider ?? promptData.provider,
    model: result.model ?? promptData.model,
    modality: "image",
    status: result.status === "ready" ? "ready" : "failed",
    latencyMs,
    requestExcerpt: stringifyPreview(promptData.prompt),
    responseExcerpt: stringifyPreview(result.url),
    artifactUrl: result.url ?? null,
    errorText: result.errorText ?? null,
    cost
  });

  await createAdminAuditLog(env, {
    userId: admin.userId,
    username: admin.username,
    action: "media_image_tested",
    targetType: "media_prompt",
    targetId: String(promptData.template.id ?? promptData.template.name)
  });

  const testResult = await createPromptTestResult(env, {
    promptKind: "media",
    promptKey: promptData.template.name,
    promptTemplateId: promptData.template.id ?? null,
    provider: result.provider ?? promptData.provider,
    model: result.model ?? promptData.model,
    modality: "image",
    status: result.status === "ready" ? "ready" : "failed",
    latencyMs,
    inputJson: JSON.stringify({
      templateId: promptData.template.id,
      title: body.title ?? "",
      sourceText: body.sourceText ?? body.text ?? "",
      prompt: promptData.prompt,
      provider: promptData.provider,
      settings: promptData.settings
    }),
    outputJson: result.status === "ready" ? JSON.stringify({ url: result.url }) : null,
    promptPreview: stringifyPreview(promptData.prompt),
    artifactUrl: result.url ?? null,
    errorText: result.errorText ?? null,
    storyId: body.storyId ?? null,
    hnUrl: body.hnUrl ?? null,
    createdBy: admin.username,
    cost
  });

  if (result.status !== "ready") {
    return json(enrichTestPayloadWithCost({
      modality: "image",
      prompt: promptData.prompt,
      provider: result.provider ?? promptData.provider,
      model: result.model ?? promptData.model,
      latencyMs,
      settings: promptData.settings,
      assetUrl: result.url ?? null,
      status: "failed",
      errorText: result.errorText ?? "Image generation failed",
      testResultId: testResult?.id ?? null
    }, cost), { status: 200 });
  }

  return json(enrichTestPayloadWithCost({
    modality: "image",
    prompt: promptData.prompt,
    provider: result.provider ?? promptData.provider,
    model: result.model ?? promptData.model,
    latencyMs,
    settings: promptData.settings,
    assetUrl: result.url,
    status: "ready",
    testResultId: testResult?.id ?? null
  }, cost));
}

async function handleVideoTest(request, env) {
  const { admin } = await requireAdmin(request, env);
  const body = (await readJson(request)) ?? {};
  const promptData = await resolveMediaPrompt(body, "video", env);

  const startedAt = Date.now();
  const result = await generateVideoWithProvider(env, {
    provider: promptData.provider,
    model: promptData.model,
    settings: promptData.settings,
    prompt: promptData.prompt,
    proxyPathBase: "/api"
  });
  const latencyMs = Date.now() - startedAt;
  const assetUrl = result.proxyPath ? new URL(result.proxyPath, request.url).toString() : (result.url ?? null);
  const cost = await calculateMediaCost(env, {
    provider: promptData.provider,
    model: promptData.model,
    modality: "video",
    settings: promptData.settings
  }, result);

  await createPromptRunEvent(env, {
    source: "admin",
    promptKind: "media",
    promptKey: promptData.template.name,
    promptTemplateId: promptData.template.id,
    provider: result.provider ?? promptData.provider,
    model: result.model ?? promptData.model,
    modality: "video",
    status: result.status === "ready" ? "ready" : "failed",
    latencyMs,
    requestExcerpt: stringifyPreview(promptData.prompt),
    responseExcerpt: stringifyPreview(assetUrl),
    artifactUrl: assetUrl,
    errorText: result.errorText ?? null,
    cost
  });

  await createAdminAuditLog(env, {
    userId: admin.userId,
    username: admin.username,
    action: "media_video_tested",
    targetType: "media_prompt",
    targetId: String(promptData.template.id ?? promptData.template.name)
  });

  const testResult = await createPromptTestResult(env, {
    promptKind: "media",
    promptKey: promptData.template.name,
    promptTemplateId: promptData.template.id ?? null,
    provider: result.provider ?? promptData.provider,
    model: result.model ?? promptData.model,
    modality: "video",
    status: result.status === "ready" ? "ready" : "failed",
    latencyMs,
    inputJson: JSON.stringify({
      templateId: promptData.template.id,
      title: body.title ?? "",
      sourceText: body.sourceText ?? body.text ?? "",
      prompt: promptData.prompt,
      provider: promptData.provider,
      settings: promptData.settings
    }),
    outputJson: result.status === "ready" ? JSON.stringify({ url: assetUrl, thumbnailUrl: result.thumbnailUrl ?? null }) : null,
    promptPreview: stringifyPreview(promptData.prompt),
    artifactUrl: assetUrl,
    errorText: result.errorText ?? null,
    storyId: body.storyId ?? null,
    hnUrl: body.hnUrl ?? null,
    createdBy: admin.username,
    cost
  });

  if (result.status !== "ready") {
    return json(enrichTestPayloadWithCost({
      modality: "video",
      prompt: promptData.prompt,
      provider: result.provider ?? promptData.provider,
      model: result.model ?? promptData.model,
      latencyMs,
      settings: promptData.settings,
      assetUrl,
      thumbnailUrl: result.thumbnailUrl ?? null,
      status: "failed",
      errorText: result.errorText ?? "Video generation failed",
      testResultId: testResult?.id ?? null
    }, cost), { status: 200 });
  }

  return json(enrichTestPayloadWithCost({
    modality: "video",
    prompt: promptData.prompt,
    provider: result.provider ?? promptData.provider,
    model: result.model ?? promptData.model,
    latencyMs,
    settings: promptData.settings,
    assetUrl,
    thumbnailUrl: result.thumbnailUrl ?? null,
    status: "ready",
    testResultId: testResult?.id ?? null
  }, cost));
}

async function handleListTestResults(request, env) {
  await requireAdmin(request, env);
  const url = new URL(request.url);
  const promptKind = url.searchParams.get("promptKind") || null;
  const promptKey = url.searchParams.get("promptKey") || null;
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 20), 100);
  return json({
    results: await listPromptTestResults(env, { promptKind, promptKey, limit })
  });
}

async function handleSelectTestResult(request, env, resultId) {
  const { admin } = await requireAdmin(request, env);
  const body = (await readJson(request)) ?? {};
  const promptKind = String(body.promptKind ?? "").trim();
  const promptKey = String(body.promptKey ?? "").trim();
  if (!promptKind || !promptKey) {
    return error("promptKind and promptKey are required", 422);
  }

  await selectPromptTestResult(env, Number(resultId), promptKind, promptKey);
  await createAdminAuditLog(env, {
    userId: admin.userId,
    username: admin.username,
    action: "test_result_selected",
    targetType: "prompt_test_result",
    targetId: String(resultId)
  });

  return json({ ok: true });
}

async function handleUpdateTestResultNotes(request, env, resultId) {
  await requireAdmin(request, env);
  const body = (await readJson(request)) ?? {};
  const notes = String(body.notes ?? "");
  await updatePromptTestResultNotes(env, Number(resultId), notes);
  return json({ ok: true });
}

function stripHtmlTags(html) {
  if (!html) return "";
  return html
    .replace(/<p>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

async function fetchCommentsFlat(kids, depth, maxTotal) {
  if (!kids || kids.length === 0 || maxTotal <= 0) return [];

  const batch = kids.slice(0, Math.min(kids.length, maxTotal));
  const items = await Promise.all(
    batch.map(async (id) => {
      try {
        return await fetchItem(id);
      } catch {
        return null;
      }
    })
  );

  const comments = [];
  for (const item of items) {
    if (!item || item.deleted || item.dead || item.type !== "comment") continue;
    comments.push({
      id: item.id,
      parentId: item.parent ?? null,
      author: item.by ?? "",
      text: stripHtmlTags(item.text ?? ""),
      depth
    });
    if (comments.length >= maxTotal) break;
  }

  const remaining = maxTotal - comments.length;
  if (remaining > 0) {
    const childKids = items
      .filter((item) => item && !item.deleted && !item.dead && item.kids?.length > 0)
      .flatMap((item) => item.kids);
    if (childKids.length > 0) {
      const childComments = await fetchCommentsFlat(childKids, depth + 1, remaining);
      comments.push(...childComments);
    }
  }

  return comments;
}

async function handleHnFetch(request, env) {
  await requireAdmin(request, env);
  const body = (await readJson(request)) ?? {};

  let storyId = body.storyId ? Number(body.storyId) : null;
  if (!storyId && body.url) {
    const match = String(body.url).match(/[?&]id=(\d+)/);
    if (match) {
      storyId = Number(match[1]);
    }
  }
  if (!storyId) {
    return error("Provide a HN URL or storyId", 422);
  }

  log.info({ event: "hn_fetch_start", storyId });

  const item = await fetchItem(storyId);
  if (!item) {
    log.warn({ event: "hn_fetch_not_found", storyId });
    return error("Story not found", 404);
  }

  log.info({ event: "hn_fetch_item", storyId, title: item.title, hasText: !!item.text, hasUrl: !!item.url });

  const [article, comments] = await Promise.all([
    resolveArticleContent(env, storyId, {
      title: item.title ?? "",
      text: item.text ?? "",
      url: item.url ?? null
    }),
    fetchCommentsFlat(item.kids ?? [], 0, 50)
  ]);

  log.info({
    event: "hn_fetch_resolved",
    storyId,
    sourceKind: article.sourceKind,
    textLength: article.text.length,
    commentCount: comments.length
  });

  return json({
    story: {
      id: item.id,
      title: item.title ?? "",
      text: article.text,
      url: item.url ?? null,
      score: item.score ?? 0,
      commentCount: item.descendants ?? 0
    },
    comments
  });
}

async function serveAsset(request, env) {
  if (!env.ASSETS?.fetch) {
    return new Response("Admin assets are not built yet.", { status: 503 });
  }
  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = adminApiPath(url.pathname);

    if (!url.pathname.startsWith("/api/")) {
      return serveAsset(request, env);
    }

    if (request.method === "OPTIONS") {
      return handlePreflight(request);
    }

    try {
      if (request.method === "GET" && path === "/auth/session") {
        return withAdminCors(request, await handleSession(request, env));
      }
      if (request.method === "POST" && path === "/auth/login") {
        return withAdminCors(request, await handleLogin(request, env));
      }
      if (request.method === "POST" && path === "/auth/logout") {
        return withAdminCors(request, await handleLogout(request, env));
      }
      if (request.method === "GET" && path === "/prompts") {
        return withAdminCors(request, await handlePrompts(request, env));
      }
      if (request.method === "GET" && path === "/model-catalog") {
        return withAdminCors(request, await handleModelCatalog(request, env));
      }
      if (request.method === "GET" && path === "/prompts/default-template") {
        await requireAdmin(request, env);
        const url = new URL(request.url);
        const key = url.searchParams.get("key") ?? "";
        const provider = url.searchParams.get("provider") ?? "openai";
        return withAdminCors(request, json({ userPromptTemplate: getDefaultUserPromptForProvider(key, provider) }));
      }
      if (request.method === "PUT" && path.startsWith("/prompts/ai/")) {
        return withAdminCors(
          request,
          await handleUpdateAIPrompt(request, env, decodeURIComponent(path.slice("/prompts/ai/".length)))
        );
      }
      if (request.method === "POST" && path === "/prompts/media") {
        return withAdminCors(request, await handleCreateMediaPrompt(request, env));
      }
      if (request.method === "PUT" && path.startsWith("/prompts/media/")) {
        return withAdminCors(request, await handleUpdateMediaPrompt(request, env, path.slice("/prompts/media/".length)));
      }
      if (request.method === "GET" && path === "/stats/overview") {
        return withAdminCors(request, await handleOverview(request, env));
      }
      if (request.method === "GET" && path === "/stats/prompts") {
        return withAdminCors(request, await handlePromptStats(request, env));
      }
      if (request.method === "GET" && path === "/test-results") {
        return withAdminCors(request, await handleListTestResults(request, env));
      }
      if (request.method === "PUT" && path.startsWith("/test-results/") && path.endsWith("/select")) {
        const resultId = path.slice("/test-results/".length, -"/select".length);
        return withAdminCors(request, await handleSelectTestResult(request, env, resultId));
      }
      if (request.method === "PUT" && path.startsWith("/test-results/") && path.endsWith("/notes")) {
        const resultId = path.slice("/test-results/".length, -"/notes".length);
        return withAdminCors(request, await handleUpdateTestResultNotes(request, env, resultId));
      }
      if (request.method === "POST" && path === "/hn/fetch") {
        return withAdminCors(request, await handleHnFetch(request, env));
      }
      if (request.method === "POST" && path === "/test/ai") {
        return withAdminCors(request, await handleAITest(request, env));
      }
      if (request.method === "POST" && path === "/test/image") {
        return withAdminCors(request, await handleImageTest(request, env));
      }
      if (request.method === "POST" && path === "/test/video") {
        return withAdminCors(request, await handleVideoTest(request, env));
      }
      if (request.method === "GET" && path.startsWith("/generated/video/openai/")) {
        await requireAdmin(request, env);
        return withAdminCors(request, await proxyOpenAIVideoContent(env, path.slice("/generated/video/openai/".length)));
      }
      if (request.method === "GET" && path === "/health") {
        return withAdminCors(request, json({ ok: true, service: "newsroll-admin", environment: env.ENVIRONMENT ?? "unknown" }));
      }
      // RSS source management
      if (request.method === "GET" && path === "/rss-sources") {
        return withAdminCors(request, await handleListRSSSources(request, env));
      }
      if (request.method === "POST" && path === "/rss-sources") {
        return withAdminCors(request, await handleCreateRSSSource(request, env));
      }
      if (request.method === "PATCH" && path.startsWith("/rss-sources/") && !path.endsWith("/fetch")) {
        return withAdminCors(request, await handleUpdateRSSSource(request, env, path.slice("/rss-sources/".length)));
      }
      if (request.method === "DELETE" && path.startsWith("/rss-sources/")) {
        return withAdminCors(request, await handleDeleteRSSSource(request, env, path.slice("/rss-sources/".length)));
      }
      if (request.method === "POST" && path.startsWith("/rss-sources/") && path.endsWith("/fetch")) {
        return withAdminCors(request, await handleFetchRSSSource(request, env, path.slice("/rss-sources/".length, -"/fetch".length)));
      }

      return withAdminCors(request, error("Route not found", 404));
    } catch (thrown) {
      return withAdminCors(
        request,
        thrown instanceof Response
          ? thrown
          : error(thrown instanceof Error ? thrown.message : "Unexpected error", 500)
      );
    }
  }
};
