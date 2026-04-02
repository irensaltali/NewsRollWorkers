import { buildAppConfig } from "./config.mjs";
import {
  getReadableContent,
  getAIPromptConfig,
  getCachedAIResult,
  createPromptRunEvent,
  hasAIRequestReceipt,
  listPublishedVisualFeed,
  storeStoryExplanation,
  storeStorySummary,
  storeAIRequestReceipt,
  storeCachedAIResult
} from "./db.mjs";
import { error, json, readJson, bearerToken } from "./http.mjs";
import * as log from "./log.mjs";

import { verifySupabaseJWT } from "./security.mjs";
import {
  buildVisualFeedResponse,
  parseVisualFeedCursor,
  parseVisualFeedLimit,
  readVisualFeedSnapshot,
  toVisualFeedItem
} from "./visual-feed.mjs";
import { validateEventBatch, storeEvents } from "./events.mjs";
import { generateRecommendedFeed } from "./recommendation.mjs";
import { processAIRequest, authorizeAIRequest, ensureAIRequestBalance, finalizeAIRequestCharge, CREDIT_COSTS } from "./credits.mjs";
import {
  formatExplainResult,
  generateSummary,
  generateSummaryViaCrawl,
  generateStructuredTranslation,
  generateThreadIntelligence,
  generateExplain,
  generateExplainViaCrawl,
  hasOpenAIConfig
} from "./ai-gateway.mjs";
import { AI_ACTIONS } from "./ai-actions.mjs";
import { listAIFeatures } from "./ai-feature-config.mjs";
import { getSubscriberInfo, getCreditBalance } from "./revenuecat.mjs";
import { resolveArticleContent, resolveArticleUrl } from "./article-content.mjs";
import { promptConfigWithFallback } from "./prompt-config.mjs";

function now() {
  return new Date().toISOString();
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

async function resolveAIProvider(env, promptKey) {
  const config = promptConfigWithFallback(await getAIPromptConfig(env, promptKey), promptKey);
  return config?.provider ?? "openai";
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
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function normalizeTranslationStory(storyId, story) {
  return {
    id: Number(story?.id ?? storyId),
    title: normalizeText(story?.title),
    text: normalizeText(story?.text)
  };
}

function normalizeStructuredComments(comments) {
  if (!Array.isArray(comments)) {
    return [];
  }

  return comments
    .filter((comment) => Number.isInteger(comment?.id))
    .map((comment) => ({
      id: Number(comment.id),
      parentId: Number.isInteger(comment.parentId) ? Number(comment.parentId) : null,
      author: normalizeText(comment.author),
      text: normalizeText(comment.text),
      depth: Number.isInteger(comment.depth) ? Number(comment.depth) : 0
    }));
}

function translationHashSource(payload) {
  return {
    storyId: payload.storyId,
    targetLanguage: payload.targetLanguage,
    story: {
      id: payload.story.id,
      title: payload.story.title,
      text: payload.story.text
    },
    comments: payload.comments.map((comment) => ({
      id: comment.id,
      text: comment.text
    }))
  };
}

async function buildTranslationPayload(env, body) {
  const storyId = Number(body.storyId);
  const targetLanguage = normalizeText(body.targetLanguage);
  const story = normalizeTranslationStory(storyId, body.story);
  const resolvedStory = await resolveArticleContent(env, storyId, {
    title: story.title,
    text: story.text,
    url: body.story?.url
  });
  const comments = normalizeStructuredComments(body.comments);
  const source = {
    storyId,
    targetLanguage,
    story: {
      ...story,
      title: resolvedStory.title || story.title,
      text: resolvedStory.text
    },
    comments
  };
  const contentHash = await sha256Hex(sortedJson(translationHashSource(source)));

  return {
    ...source,
    contentHash
  };
}

function translationCacheKey(payload) {
  return `translation:v2:${payload.storyId}:${payload.targetLanguage}:${payload.contentHash}`;
}

function parseCachedTranslation(value) {
  try {
    const parsed = JSON.parse(value);
    if (!parsed?.story || !Array.isArray(parsed?.comments) || !parsed?.contentHash || !parsed?.targetLanguage) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function translationCacheExpiryIso() {
  return new Date(Date.now() + AI_ACTIONS.translation.cacheTtlMs).toISOString();
}

function normalizeThreadPayload(body) {
  const storyId = Number(body.storyId);
  const title = normalizeText(body.title);
  const comments = normalizeStructuredComments(body.comments);
  return { storyId, title, comments };
}

function threadIntelligenceHashSource(payload) {
  return {
    storyId: payload.storyId,
    title: payload.title,
    comments: payload.comments.map((comment) => ({
      id: comment.id,
      text: comment.text
    }))
  };
}

async function buildThreadIntelligencePayload(body) {
  const source = normalizeThreadPayload(body);
  const contentHash = await sha256Hex(sortedJson(threadIntelligenceHashSource(source)));
  return {
    ...source,
    contentHash
  };
}

function threadIntelligenceCacheKey(payload) {
  return `thread_intelligence:v1:${payload.storyId}:${payload.contentHash}`;
}

function parseCachedThreadIntelligence(value) {
  try {
    const parsed = JSON.parse(value);
    if (
      typeof parsed?.summary !== "string" ||
      !Array.isArray(parsed?.keyInsights) ||
      typeof parsed?.discussionShape !== "string" ||
      typeof parsed?.contentHash !== "string"
    ) {
      return null;
    }

    return {
      summary: parsed.summary.trim(),
      keyInsights: parsed.keyInsights.filter((item) => typeof item === "string" && item.trim().length > 0),
      discussionShape: parsed.discussionShape,
      contentHash: parsed.contentHash
    };
  } catch {
    return null;
  }
}

function explainContentHashSource(payload) {
  return {
    storyId: payload.storyId,
    title: payload.title,
    text: payload.text
  };
}

async function buildExplainPayload(body, fallbackLevel = "technical") {
  const storyId = Number(body.storyId);
  const title = normalizeText(body.title);
  const text = normalizeText(body.text);
  const normalizedLevel = normalizeText(body.level || fallbackLevel).toLowerCase();
  const level = normalizedLevel === "simple" ? "simple" : "technical";
  const contentHash = await sha256Hex(sortedJson(explainContentHashSource({ storyId, title, text })));
  const payload = {
    storyId,
    title,
    text,
    level,
    contentHash
  };
  if (body._cfCrawl) {
    payload._cfCrawl = true;
    payload.url = body.url ?? null;
  }
  return payload;
}

function explainCacheKey(payload) {
  return `explain:v1:${payload.level}:${payload.storyId}:${payload.contentHash}`;
}

function parseCachedExplain(value) {
  try {
    const parsed = JSON.parse(value);
    if (
      typeof parsed?.title !== "string" ||
      !Array.isArray(parsed?.sections) ||
      !Array.isArray(parsed?.followUps) ||
      typeof parsed?.level !== "string" ||
      typeof parsed?.contentHash !== "string"
    ) {
      return null;
    }

    const sections = parsed.sections
      .filter((section) => typeof section?.heading === "string" && typeof section?.body === "string")
      .map((section) => ({
        heading: section.heading.trim(),
        body: section.body.trim()
      }))
      .filter((section) => section.heading && section.body);

    if (!sections.length) {
      return null;
    }

    return {
      title: parsed.title.trim(),
      sections,
      followUps: parsed.followUps.filter((item) => typeof item === "string" && item.trim().length > 0),
      level: parsed.level === "simple" ? "simple" : "technical",
      contentHash: parsed.contentHash
    };
  } catch {
    return null;
  }
}

function aiCacheExpiryIso(actionKey) {
  const ttlMs = AI_ACTIONS[actionKey]?.cacheTtlMs;
  return ttlMs ? new Date(Date.now() + ttlMs).toISOString() : null;
}

async function handleStructuredCachedAIRequest(request, env, {
  actionKey,
  buildPayload,
  validatePayload,
  cacheKeyFor,
  parseCached,
  generate,
  toResponsePayload,
  resultType = actionKey,
  provider = "openai",
  persistResult = null
}) {
  const user = await requireUser(request, env);
  const userErr = guardUser(user);
  if (userErr) return userErr;
  const body = (await readJson(request)) ?? {};
  const revenueCatAppUserId = revenueCatAppUserIdForUser(user);
  const auth = await authorizeAIRequest(env, revenueCatAppUserId, actionKey, { requireBalance: false });
  const authError = aiBillingError(auth);
  if (authError) return authError;

  if (provider !== "cloudflare" && !hasOpenAIConfig(env)) {
    log.warn({ event: "ai_provider_unavailable", provider: "openai", action: actionKey, reason: "missing_api_key" });
    return error("AI provider unavailable", 503, { code: "ai_provider_unavailable", provider: "openai" });
  }

  const payload = await buildPayload(body);
  const payloadError = validatePayload?.(payload);
  if (payloadError) {
    return error(payloadError, 422);
  }

  const receiptKey = {
    subscriberId: revenueCatAppUserId,
    action: actionKey,
    storyId: payload.storyId,
    targetLanguage: payload.targetLanguage ?? null,
    contentHash: payload.contentHash
  };
  const alreadyCharged = await hasAIRequestReceipt(env, receiptKey);

  if (!alreadyCharged) {
    const balanceGate = await ensureAIRequestBalance(env, revenueCatAppUserId, actionKey);
    const balanceError = aiBillingError(balanceGate);
    if (balanceError) return balanceError;
  }

  const cacheKey = cacheKeyFor(payload);
  const cached = await getCachedAIResult(env, cacheKey);
  const cachedPayload = cached ? parseCached(cached.resultText) : null;
  if (cachedPayload) {
    await createPromptRunEvent(env, {
      source: "app_api",
      promptKind: "ai",
      promptKey: actionKey,
      provider,
      model: AI_ACTIONS[actionKey].model,
      modality: "text",
      status: "cached",
      latencyMs: 0,
      cacheHit: true,
      requestExcerpt: JSON.stringify(payload).slice(0, 500),
      responseExcerpt: JSON.stringify(cachedPayload).slice(0, 500),
      storyId: payload.storyId
    });

    let charge = null;
    if (!alreadyCharged) {
      charge = await finalizeAIRequestCharge(env, revenueCatAppUserId, actionKey, cacheKey, auth.cost);
      const chargeError = aiBillingError(charge);
      if (chargeError) return chargeError;
      await storeAIRequestReceipt(env, receiptKey);
    }

    return json({
      ...cachedPayload,
      creditsUsed: alreadyCharged ? 0 : auth.cost,
      balanceAfter: alreadyCharged ? null : charge.balance,
      cached: true,
      charged: !alreadyCharged
    });
  }

  const result = await generate(payload);
  if (!result) {
    await createPromptRunEvent(env, {
      source: "app_api",
      promptKind: "ai",
      promptKey: actionKey,
      provider,
      model: AI_ACTIONS[actionKey].model,
      modality: "text",
      status: "failed",
      requestExcerpt: JSON.stringify(payload).slice(0, 500),
      errorText: "AI generation failed",
      storyId: payload.storyId
    });
    return error("AI generation failed", 502);
  }

  const responsePayload = toResponsePayload(payload, result);
  await storeCachedAIResult(env, {
    cacheKey,
    resultType,
    storyId: payload.storyId,
    resultText: JSON.stringify(responsePayload),
    model: AI_ACTIONS[actionKey].model,
    expiresAt: aiCacheExpiryIso(actionKey)
  });
  if (typeof persistResult === "function") {
    await persistResult(payload, result, responsePayload);
  }

  await createPromptRunEvent(env, {
    source: "app_api",
    promptKind: "ai",
    promptKey: actionKey,
    provider,
    model: AI_ACTIONS[actionKey].model,
    modality: "text",
    status: "completed",
    requestExcerpt: JSON.stringify(payload).slice(0, 500),
    responseExcerpt: JSON.stringify(responsePayload).slice(0, 500),
    storyId: payload.storyId
  });

  if (alreadyCharged) {
    return json({
      ...responsePayload,
      creditsUsed: 0,
      balanceAfter: null,
      cached: false,
      charged: false
    });
  }

  const charge = await finalizeAIRequestCharge(env, revenueCatAppUserId, actionKey, cacheKey, auth.cost);
  const chargeError = aiBillingError(charge);
  if (chargeError) return chargeError;
  await storeAIRequestReceipt(env, receiptKey);

  return json({
    ...responsePayload,
    creditsUsed: auth.cost,
    balanceAfter: charge.balance,
    cached: false,
    charged: true
  });
}

function revenueCatAppUserIdForUser(user) {
  return user?.userId;
}

function aiBillingError(result) {
  if (result?.error === "subscription_status_unavailable") {
    return error("Subscription status unavailable", 503, { code: "subscription_status_unavailable" });
  }
  if (result?.error === "credit_balance_unavailable") {
    return error("Credit balance unavailable", 503, { code: "credit_balance_unavailable" });
  }
  if (result?.error === "pro_required") {
    return error("Pro subscription required", 402, { code: "pro_required" });
  }
  if (result?.error === "insufficient_credits") {
    return error("Insufficient credits", 402, { code: "insufficient_credits", balance: result.balance, required: result.required });
  }
  if (result?.error) {
    return error(result.error, 500);
  }
  return null;
}

const ALLOWED_ORIGINS = [
  "https://admin.newsroll.app",
  "https://admin-staging.newsroll.app",
  "https://newsroll.app"
];

function corsOrigin(request) {
  const origin = request?.headers?.get?.("origin") ?? "";
  return ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
}

function buildCorsHeaders(request) {
  return {
    "access-control-allow-origin": corsOrigin(request),
    "access-control-allow-methods": "GET, POST, PATCH, OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization",
    "access-control-max-age": "86400"
  };
}

function withCors(response, request) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(buildCorsHeaders(request))) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

async function userContext(request, env) {
  const token = bearerToken(request);
  if (!token) return null;

  const claims = await verifySupabaseJWT(token, {
    jwtSecret: env.SUPABASE_JWT_SECRET,
    supabaseUrl: env.SUPABASE_URL
  });
  return claims?.sub ? { userId: claims.sub } : null;
}

async function requireUser(request, env) {
  const ctx = await userContext(request, env);
  if (!ctx?.userId) return null;
  return ctx;
}

function guardUser(user) {
  if (!user) return error("Missing or invalid token", 401);
  return null;
}

async function handleConfig(_request, env) {
  return json(buildAppConfig(env));
}

async function handleVisualFeed(request, env) {
  const url = new URL(request.url);
  const cursorValue = url.searchParams.get("cursor");
  const cursor = parseVisualFeedCursor(cursorValue);
  const limit = parseVisualFeedLimit(env, url.searchParams.get("limit"));
  const user = await userContext(request, env);

  if (user?.userId && env?.SUPABASE_URL) {
    const result = await generateRecommendedFeed(env, user.userId, {
      cursor: cursorValue,
      limit
    });

    if (!result.coldStart) {
      return json({
        cursor: cursorValue ?? null,
        nextCursor: result.nextCursor ?? null,
        items: (result.items ?? []).map((item) => toVisualFeedItem(env, item))
      }, {
        headers: {
          "cache-control": "private, max-age=0, no-store"
        }
      });
    }
  }

  if (cursor == null) {
    const snapshot = await readVisualFeedSnapshot(env);
    if (snapshot?.length) {
      return json(buildVisualFeedResponse(env, snapshot, cursor, limit), {
        headers: {
          "cache-control": "public, max-age=15, stale-while-revalidate=60"
        }
      });
    }
  }

  const items = await listPublishedVisualFeed(env, { cursor, limit });
  return json(buildVisualFeedResponse(env, items, cursor, limit), {
    headers: {
      "cache-control": "public, max-age=15, stale-while-revalidate=60"
    }
  });
}

async function handleReadableArticle(env, storyId) {
  const content = await getReadableContent(env, Number(storyId));
  return new Response(content?.extractedText ?? "Readable version is not ready yet.", {
    headers: {
      "content-type": "text/plain; charset=utf-8"
    }
  });
}

async function handleEvents(request, env) {
  const user = await requireUser(request, env);
  const userErr = guardUser(user);
  if (userErr) return userErr;
  const body = (await readJson(request)) ?? {};
  const events = body.events ?? body;

  const { valid, rejected } = validateEventBatch(Array.isArray(events) ? events : []);
  if (valid.length === 0) {
    return error("No valid events provided", 422, { rejected });
  }

  const result = await storeEvents(env, user.userId, valid);
  return json({ ok: true, stored: result.stored, rejected: rejected.length });
}

async function handleForYouFeed(request, env) {
  const user = await userContext(request, env);
  const userId = user?.userId ?? null;

  const url = new URL(request.url);
  const cursor = url.searchParams.get("cursor") || null;
  const coldStartCursor = parseVisualFeedCursor(cursor);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "20", 10) || 20, 1), 50);

  if (!userId || !env?.SUPABASE_URL) {
    return json({ coldStart: true, items: [], nextCursor: null });
  }

  const result = await generateRecommendedFeed(env, userId, { cursor, limit });

  if (result.coldStart) {
    const items = await listPublishedVisualFeed(env, { cursor: coldStartCursor, limit });
    const fallback = buildVisualFeedResponse(env, items, coldStartCursor, limit);
    return json({
      coldStart: true,
      items: fallback.items,
      nextCursor: fallback.nextCursor != null ? String(fallback.nextCursor) : null
    });
  }

  return json({
    coldStart: false,
    items: (result.items ?? []).map((item) => toVisualFeedItem(env, item)),
    nextCursor: result.nextCursor ?? null
  });
}


async function handleAISummary(request, env) {
  const user = await requireUser(request, env);
  const userErr = guardUser(user);
  if (userErr) return userErr;
  const body = (await readJson(request)) ?? {};
  const storyId = body.storyId;
  if (!storyId) return error("storyId is required", 422);

  const cacheKey = `summary:${storyId}`;
  const revenueCatAppUserId = revenueCatAppUserIdForUser(user);
  const gate = await processAIRequest(env, revenueCatAppUserId, "summary", cacheKey);
  const gateError = aiBillingError(gate);
  if (gateError) return gateError;

  const provider = await resolveAIProvider(env, "summary");

  if (gate.cached) {
    await createPromptRunEvent(env, {
      source: "app_api",
      promptKind: "ai",
      promptKey: "summary",
      provider,
      model: AI_ACTIONS.summary.model,
      modality: "text",
      status: "cached",
      latencyMs: 0,
      cacheHit: true,
      requestExcerpt: JSON.stringify({ storyId, title: body.title ?? "" }).slice(0, 500),
      responseExcerpt: String(gate.result ?? "").slice(0, 500),
      storyId
    });
    const charge = await finalizeAIRequestCharge(env, revenueCatAppUserId, "summary", cacheKey, gate.cost);
    const chargeError = aiBillingError(charge);
    if (chargeError) return chargeError;
    return json({ result: gate.result, creditsUsed: gate.cost, balanceAfter: charge.balance, cached: true });
  }

  let result;
  let summaryTitle = body.title ?? "";

  if (provider === "cloudflare") {
    const articleUrl = await resolveArticleUrl(env, storyId, { url: body.url ?? null });
    if (articleUrl) {
      result = await generateSummaryViaCrawl(env, articleUrl, storyId, summaryTitle);
    } else {
      log.info({ event: "provider_fallback", provider: "cloudflare", fallback: "openai", reason: "no_url", storyId });
      const article = await resolveArticleContent(env, storyId, { title: summaryTitle, text: body.text ?? "", url: null });
      summaryTitle = article.title || summaryTitle;
      result = await generateSummary(env, storyId, summaryTitle, article.text);
    }
  } else {
    if (!hasOpenAIConfig(env)) {
      return error("AI provider unavailable", 503, { code: "ai_provider_unavailable", provider: "openai" });
    }
    const article = await resolveArticleContent(env, storyId, { title: summaryTitle, text: body.text ?? "", url: body.url ?? null });
    summaryTitle = article.title || summaryTitle;
    result = await generateSummary(env, storyId, summaryTitle, article.text);
  }

  if (!result) {
    await createPromptRunEvent(env, {
      source: "app_api",
      promptKind: "ai",
      promptKey: "summary",
      provider,
      model: AI_ACTIONS.summary.model,
      modality: "text",
      status: "failed",
      requestExcerpt: JSON.stringify({ storyId, title: summaryTitle }).slice(0, 500),
      errorText: "AI generation failed",
      storyId
    });
    return error("AI generation failed", 502);
  }

  await storeCachedAIResult(env, { cacheKey, resultType: "summary", storyId, resultText: result, model: AI_ACTIONS.summary.model });
  await storeStorySummary(env, {
    storyId,
    sourceUrl: body.url ?? null,
    summary: result,
    updatedAt: now()
  });
  await createPromptRunEvent(env, {
    source: "app_api",
    promptKind: "ai",
    promptKey: "summary",
    provider,
    model: AI_ACTIONS.summary.model,
    modality: "text",
    status: "completed",
    requestExcerpt: JSON.stringify({ storyId, title: summaryTitle }).slice(0, 500),
    responseExcerpt: String(result).slice(0, 500),
    storyId
  });
  const charge = await finalizeAIRequestCharge(env, revenueCatAppUserId, "summary", cacheKey, gate.cost);
  const chargeError = aiBillingError(charge);
  if (chargeError) return chargeError;
  return json({ result, creditsUsed: gate.cost, balanceAfter: charge.balance, cached: false });
}

async function handleAITranslate(request, env) {
  const user = await requireUser(request, env);
  const userErr = guardUser(user);
  if (userErr) return userErr;
  const body = (await readJson(request)) ?? {};
  const revenueCatAppUserId = revenueCatAppUserIdForUser(user);
  const auth = await authorizeAIRequest(env, revenueCatAppUserId, "translation", { requireBalance: false });
  const authError = aiBillingError(auth);
  if (authError) return authError;

  if (!hasOpenAIConfig(env)) {
    log.warn({ event: "ai_provider_unavailable", provider: "openai", action: "translation", reason: "missing_api_key" });
    return error("AI provider unavailable", 503, { code: "ai_provider_unavailable", provider: "openai" });
  }

  const payload = await buildTranslationPayload(env, body);
  if (!payload.storyId || !payload.targetLanguage) {
    return error("storyId and targetLanguage are required", 422);
  }

  const receiptKey = {
    subscriberId: revenueCatAppUserId,
    action: "translation",
    storyId: payload.storyId,
    targetLanguage: payload.targetLanguage,
    contentHash: payload.contentHash
  };
  const alreadyCharged = await hasAIRequestReceipt(env, receiptKey);

  if (!alreadyCharged) {
    const balanceGate = await ensureAIRequestBalance(env, revenueCatAppUserId, "translation");
    const balanceError = aiBillingError(balanceGate);
    if (balanceError) return balanceError;
  }

  const cacheKey = translationCacheKey(payload);
  const cached = await getCachedAIResult(env, cacheKey);
  const cachedTranslation = cached ? parseCachedTranslation(cached.resultText) : null;

  if (cachedTranslation) {
    await createPromptRunEvent(env, {
      source: "app_api",
      promptKind: "ai",
      promptKey: "translation",
      provider: "openai",
      model: AI_ACTIONS.translation.model,
      modality: "text",
      status: "cached",
      latencyMs: 0,
      cacheHit: true,
      requestExcerpt: JSON.stringify(payload).slice(0, 500),
      responseExcerpt: JSON.stringify(cachedTranslation).slice(0, 500),
      storyId: payload.storyId
    });
    let charge = null;
    if (!alreadyCharged) {
      charge = await finalizeAIRequestCharge(env, revenueCatAppUserId, "translation", cacheKey, auth.cost);
      const chargeError = aiBillingError(charge);
      if (chargeError) return chargeError;
      await storeAIRequestReceipt(env, receiptKey);
    }

    return json({
      ...cachedTranslation,
      creditsUsed: alreadyCharged ? 0 : auth.cost,
      balanceAfter: alreadyCharged ? null : charge.balance,
      cached: true,
      charged: !alreadyCharged
    });
  }

  const result = await generateStructuredTranslation(env, payload);
  if (!result) {
    await createPromptRunEvent(env, {
      source: "app_api",
      promptKind: "ai",
      promptKey: "translation",
      provider: "openai",
      model: AI_ACTIONS.translation.model,
      modality: "text",
      status: "failed",
      requestExcerpt: JSON.stringify(payload).slice(0, 500),
      errorText: "AI generation failed",
      storyId: payload.storyId
    });
    return error("AI generation failed", 502);
  }

  const responsePayload = {
    story: result.story,
    comments: result.comments,
    targetLanguage: payload.targetLanguage,
    contentHash: payload.contentHash
  };

  await storeCachedAIResult(env, {
    cacheKey,
    resultType: "translation",
    storyId: payload.storyId,
    resultText: JSON.stringify(responsePayload),
    model: AI_ACTIONS.translation.model,
    expiresAt: translationCacheExpiryIso()
  });

  await createPromptRunEvent(env, {
    source: "app_api",
    promptKind: "ai",
    promptKey: "translation",
    provider: "openai",
    model: AI_ACTIONS.translation.model,
    modality: "text",
    status: "completed",
    requestExcerpt: JSON.stringify(payload).slice(0, 500),
    responseExcerpt: JSON.stringify(responsePayload).slice(0, 500),
    storyId: payload.storyId
  });

  if (alreadyCharged) {
    return json({
      ...responsePayload,
      creditsUsed: 0,
      balanceAfter: null,
      cached: false,
      charged: false
    });
  }

  const charge = await finalizeAIRequestCharge(env, revenueCatAppUserId, "translation", cacheKey, auth.cost);
  const chargeError = aiBillingError(charge);
  if (chargeError) return chargeError;
  await storeAIRequestReceipt(env, receiptKey);

  return json({
    ...responsePayload,
    creditsUsed: auth.cost,
    balanceAfter: charge.balance,
    cached: false,
    charged: true
  });
}

async function handleAIThreadIntelligence(request, env) {
  return handleStructuredCachedAIRequest(request, env, {
    actionKey: "thread_intelligence",
    buildPayload: buildThreadIntelligencePayload,
    validatePayload: (payload) => {
      if (!payload.storyId) return "storyId is required";
      if (!payload.title) return "title is required";
      if (!payload.comments.length) return "comments are required";
      return null;
    },
    cacheKeyFor: threadIntelligenceCacheKey,
    parseCached: parseCachedThreadIntelligence,
    generate: (payload) => generateThreadIntelligence(env, payload),
    toResponsePayload: (payload, result) => ({
      summary: result.summary,
      keyInsights: result.keyInsights,
      discussionShape: result.discussionShape,
      contentHash: payload.contentHash
    })
  });
}

async function handleAIExplain(request, env) {
  const body = (await readJson(request.clone())) ?? {};
  const level = normalizeText(body.level).toLowerCase() === "simple" ? "simple" : "technical";
  const actionKey = level === "simple" ? "explain_simple" : "explain_technical";
  const provider = await resolveAIProvider(env, actionKey);

  return handleStructuredCachedAIRequest(request, env, {
    actionKey,
    provider,
    buildPayload: async () => {
      const storyId = Number(body.storyId);

      if (provider === "cloudflare") {
        const articleUrl = await resolveArticleUrl(env, storyId, { url: body.url ?? null });
        if (articleUrl) {
          return buildExplainPayload({ ...body, storyId, title: body.title ?? "", text: "", url: articleUrl, level, _cfCrawl: true }, level);
        }
        log.info({ event: "provider_fallback", provider: "cloudflare", fallback: "openai", reason: "no_url", storyId, action: actionKey });
      }

      const article = await resolveArticleContent(env, storyId, {
        title: body.title ?? "",
        text: body.text ?? "",
        url: body.url ?? null
      });
      return buildExplainPayload({ ...body, storyId, title: article.title || (body.title ?? ""), text: article.text, level }, level);
    },
    validatePayload: (payload) => {
      if (!payload.storyId) return "storyId is required";
      if (!payload.title) return "title is required";
      if (!payload._cfCrawl && !payload.text) return "text is required";
      return null;
    },
    cacheKeyFor: explainCacheKey,
    parseCached: parseCachedExplain,
    generate: (payload) => {
      if (payload._cfCrawl && payload.url) {
        return generateExplainViaCrawl(env, payload.url, payload.storyId, payload.title, payload.level);
      }
      return generateExplain(env, payload);
    },
    toResponsePayload: (payload, result) => ({
      title: result.title,
      sections: result.sections,
      followUps: result.followUps,
      level: result.level,
      contentHash: payload.contentHash
    }),
    persistResult: async (payload, result) => {
      await storeStoryExplanation(env, {
        storyId: payload.storyId,
        sourceUrl: payload.url ?? body.url ?? null,
        explanation: formatExplainResult(result),
        updatedAt: now()
      });
    },
    resultType: actionKey
  });
}

async function handleGetCredits(request, env) {
  const user = await requireUser(request, env);
  const userErr = guardUser(user);
  if (userErr) return userErr;
  const revenueCatAppUserId = revenueCatAppUserIdForUser(user);
  const subscriber = await getSubscriberInfo(env, revenueCatAppUserId);
  const balance = await getCreditBalance(env, revenueCatAppUserId);
  return json({
    balance,
    isPro: subscriber?.isPro ?? false,
    costs: CREDIT_COSTS,
    features: listAIFeatures()
  });
}

const ROUTES = [
  { method: "GET",   path: "/health",               name: "health",           handler: (r, e) => json({ ok: true, service: e.APP_NAME ?? "NewsRoll Backend", environment: e.ENVIRONMENT ?? "unknown" }) },
  { method: "GET",   path: "/v1/config",             name: "config",           handler: handleConfig },
  { method: "GET",   path: "/v1/visual-feed",        name: "visual_feed",      handler: handleVisualFeed },
  { method: "POST",  path: "/v1/events",             name: "events",          handler: handleEvents },
  { method: "GET",   path: "/v1/feed/for-you",        name: "feed_for_you",    handler: handleForYouFeed },
  { method: "POST",  path: "/v1/ai/summary",          name: "ai_summary",      handler: handleAISummary },
  { method: "POST",  path: "/v1/ai/translate",         name: "ai_translate",    handler: handleAITranslate },
  { method: "POST",  path: "/v1/ai/thread-intelligence", name: "ai_thread_intelligence", handler: handleAIThreadIntelligence },
  { method: "POST",  path: "/v1/ai/explain",           name: "ai_explain",      handler: handleAIExplain },
  { method: "GET",   path: "/v1/credits",              name: "credits",         handler: handleGetCredits },
];

async function routeRequest(request, env) {
  const url = new URL(request.url);
  const segments = url.pathname.split("/").filter(Boolean);

  if (request.method === "OPTIONS") {
    return { response: new Response(null, { status: 204, headers: buildCorsHeaders(request) }), route: "cors_preflight" };
  }

  for (const route of ROUTES) {
    if (request.method === route.method && url.pathname === route.path) {
      const response = await route.handler(request, env);
      return { response, route: route.name };
    }
  }

  // Dynamic segment routes
  if (request.method === "GET" && segments[0] === "v1" && segments[1] === "stories" && segments[2] && segments[3] === "article") {
    const response = await handleReadableArticle(env, segments[2]);
    return { response, route: "readable_article" };
  }

  return { response: error("Route not found", 404), route: null };
}

async function responseLogFields(response) {
  if (!(response instanceof Response) || response.status < 400) {
    return {};
  }

  const bodyText = await response.clone().text().catch(() => "");
  if (!bodyText) {
    return {};
  }

  try {
    const payload = JSON.parse(bodyText);
    const details = payload?.details;
    return {
      errorMessage: typeof payload?.error === "string" ? payload.error : undefined,
      errorCode: typeof details?.code === "string" ? details.code : undefined,
      detailsSnippet: details == null
        ? undefined
        : (typeof details === "string" ? details : JSON.stringify(details)).slice(0, 300),
      bodySnippet: typeof payload?.error === "string" ? undefined : bodyText.slice(0, 300)
    };
  } catch {
    return {
      bodySnippet: bodyText.slice(0, 300)
    };
  }
}

export default {
  async fetch(request, env) {
    const start = Date.now();
    const rid = log.requestId(request);
    const meta = log.requestMeta(request);
    try {
      const { response, route } = await routeRequest(request, env);
      const durationMs = Date.now() - start;
      const logFn = response.status >= 400 ? log.warn : log.info;
      logFn({
        event: "request",
        rid,
        route: route ?? "not_found",
        ...meta,
        status: response.status,
        durationMs,
        ...(await responseLogFields(response))
      });
      return withCors(response, request);
    } catch (thrown) {
      const durationMs = Date.now() - start;
      if (thrown instanceof Response) {
        log.warn({
          event: "request",
          rid,
          route: "thrown_response",
          ...meta,
          status: thrown.status,
          durationMs,
          ...(await responseLogFields(thrown))
        });
        return withCors(thrown, request);
      }
      log.error({
        event: "request_error",
        rid,
        ...meta,
        durationMs,
        ...log.fmtError(thrown),
      });
      return withCors(error(thrown instanceof Error ? thrown.message : "Unexpected error", 500), request);
    }
  }
};
