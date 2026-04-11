import { buildAppConfig, publicMediaUrlFor } from "./config.mjs";
import {
  getReadableContent,
  getAIPromptConfig,
  getCachedAIResult,
  createPromptRunEvent,
  hasAIRequestReceipt,
  listPublishedVisualFeed,
  getPublishedFeedEntriesByStoryIds,
  storeStoryExplanation,
  storeStoryExplanationData,
  getStoryExplanationData,
  getStorySummaryAndContent,
  storeStorySummary,
  storeAIRequestReceipt,
  storeCachedAIResult,
  getPromptTemplateById
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
import { authorizeAIRequest, ensureAIRequestBalance, finalizeAIRequestCharge, CREDIT_COSTS } from "./credits.mjs";
import {
  formatExplainResult,
  generateSummary,
  generateSummaryViaCrawl,
  generateStructuredTranslation,
  generateExplain,
  generateExplainViaCrawl,
  hasOpenAIConfig
} from "./ai-gateway.mjs";
import { AI_ACTIONS } from "./ai-actions.mjs";
import { listAIFeatures } from "./ai-feature-config.mjs";
import { getSubscriberInfo, getCreditBalance } from "./revenuecat.mjs";
import { resolveArticleContent, resolveArticleUrl } from "./article-content.mjs";
import { promptConfigWithFallback, mediaTemplateWithFallback, buildPromptInput, clipPromptText } from "./prompt-config.mjs";
import { generateImageWithProvider } from "./media-generation.mjs";
import { crawlUrl } from "./browser-rendering.mjs";
import { queryPersonalizedFeed } from "./shaped.mjs";

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
  persistResult = null,
  dbLookup = null,
  cacheDelay = 0
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

  // DB-first lookup (persistent storage beyond cache TTL)
  if (typeof dbLookup === "function") {
    const dbPayload = await dbLookup(payload);
    if (dbPayload) {
      log.info({ event: "ai_db_hit", action: actionKey, storyId: payload.storyId });
      if (cacheDelay > 0) {
        await new Promise((r) => setTimeout(r, cacheDelay));
      }
      await createPromptRunEvent(env, {
        source: "app_api",
        promptKind: "ai",
        promptKey: actionKey,
        provider,
        model: AI_ACTIONS[actionKey].model,
        modality: "text",
        status: "cached",
        latencyMs: cacheDelay,
        cacheHit: true,
        requestExcerpt: JSON.stringify(payload).slice(0, 500),
        responseExcerpt: JSON.stringify(dbPayload).slice(0, 500),
        storyId: payload.storyId
      });

      if (alreadyCharged) {
        return json({ ...dbPayload, creditsUsed: 0, balanceAfter: null, cached: true, charged: false });
      }
      const charge = await finalizeAIRequestCharge(env, revenueCatAppUserId, actionKey, cacheKeyFor(payload), auth.cost);
      const chargeError = aiBillingError(charge);
      if (chargeError) return chargeError;
      await storeAIRequestReceipt(env, receiptKey);
      return json({ ...dbPayload, creditsUsed: auth.cost, balanceAfter: charge.balance, cached: true, charged: true });
    }
  }

  const cacheKey = cacheKeyFor(payload);
  const cached = await getCachedAIResult(env, cacheKey);
  const cachedPayload = cached ? parseCached(cached.resultText) : null;
  if (cachedPayload) {
    log.info({ event: "ai_cache_hit", action: actionKey, storyId: payload.storyId });
    if (cacheDelay > 0) {
      await new Promise((r) => setTimeout(r, cacheDelay));
    }
    await createPromptRunEvent(env, {
      source: "app_api",
      promptKind: "ai",
      promptKey: actionKey,
      provider,
      model: AI_ACTIONS[actionKey].model,
      modality: "text",
      status: "cached",
      latencyMs: cacheDelay,
      cacheHit: true,
      requestExcerpt: JSON.stringify(payload).slice(0, 500),
      responseExcerpt: JSON.stringify(cachedPayload).slice(0, 500),
      storyId: payload.storyId
    });

    if (alreadyCharged) {
      return json({ ...cachedPayload, creditsUsed: 0, balanceAfter: null, cached: true, charged: false });
    }
    const charge = await finalizeAIRequestCharge(env, revenueCatAppUserId, actionKey, cacheKey, auth.cost);
    const chargeError = aiBillingError(charge);
    if (chargeError) return chargeError;
    await storeAIRequestReceipt(env, receiptKey);
    return json({ ...cachedPayload, creditsUsed: auth.cost, balanceAfter: charge.balance, cached: true, charged: true });
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
    return json({ ...responsePayload, creditsUsed: 0, balanceAfter: null, cached: false, charged: false });
  }

  const charge = await finalizeAIRequestCharge(env, revenueCatAppUserId, actionKey, cacheKey, auth.cost);
  const chargeError = aiBillingError(charge);
  if (chargeError) return chargeError;
  await storeAIRequestReceipt(env, receiptKey);

  return json({ ...responsePayload, creditsUsed: auth.cost, balanceAfter: charge.balance, cached: false, charged: true });
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

const ALLOWED_ORIGINS = ["https://newsroll.app"];

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
  const cursorRaw = url.searchParams.get("cursor");
  const limit = parseVisualFeedLimit(env, url.searchParams.get("limit"));
  const user = await userContext(request, env);

  // Personalized path for authenticated users via Shaped
  if (user?.userId) {
    const offset = cursorRaw ? Math.max(0, Number.parseInt(cursorRaw, 10) || 0) : 0;
    const recommendations = await queryPersonalizedFeed(env, user.userId, { count: offset + limit + 1 });

    if (recommendations.length > 0) {
      const page = recommendations.slice(offset, offset + limit);
      const hasMore = recommendations.length > offset + limit;
      const enriched = await getPublishedFeedEntriesByStoryIds(env, page.map((r) => r.id));
      return json(
        {
          cursor: cursorRaw ?? null,
          nextCursor: hasMore ? String(offset + limit) : null,
          items: enriched.map((row) => toVisualFeedItem(env, row))
        },
        { headers: { "cache-control": "private, max-age=30" } }
      );
    }
  }

  // Global fallback: anonymous users or Shaped cold start
  const cursor = parseVisualFeedCursor(cursorRaw);
  if (cursor == null) {
    const snapshot = await readVisualFeedSnapshot(env);
    if (snapshot?.length) {
      return json(buildVisualFeedResponse(env, snapshot, cursor, limit), {
        headers: { "cache-control": "public, max-age=15, stale-while-revalidate=60" }
      });
    }
  }

  const items = await listPublishedVisualFeed(env, { cursor, limit });
  return json(buildVisualFeedResponse(env, items, cursor, limit), {
    headers: { "cache-control": "public, max-age=15, stale-while-revalidate=60" }
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

async function handleEvents(request, env, ctx) {
  const user = await requireUser(request, env);
  const userErr = guardUser(user);
  if (userErr) return userErr;
  const body = (await readJson(request)) ?? {};
  const events = body.events ?? body;

  const { valid, rejected } = validateEventBatch(Array.isArray(events) ? events : []);
  if (valid.length === 0) {
    return error("No valid events provided", 422, { rejected });
  }

  const result = await storeEvents(env, user.userId, valid, ctx);
  return json({ ok: true, stored: result.stored, rejected: rejected.length });
}

async function handleAISummary(request, env) {
  const user = await requireUser(request, env);
  const userErr = guardUser(user);
  if (userErr) return userErr;
  const body = (await readJson(request)) ?? {};
  const storyId = Number(body.storyId);
  if (!storyId) return error("storyId is required", 422);

  const revenueCatAppUserId = revenueCatAppUserIdForUser(user);

  // Pro + balance check (balance only if not already charged)
  const auth = await authorizeAIRequest(env, revenueCatAppUserId, "summary", { requireBalance: false });
  const authError = aiBillingError(auth);
  if (authError) return authError;

  // Receipt-based dedup: never charge same user twice for the same story's summary
  const receiptKey = { subscriberId: revenueCatAppUserId, action: "summary", storyId, targetLanguage: null, contentHash: "" };
  const alreadyCharged = await hasAIRequestReceipt(env, receiptKey);
  log.info({ event: "ai_summary_receipt_check", storyId, subscriberId: revenueCatAppUserId, alreadyCharged });

  if (!alreadyCharged) {
    const balanceGate = await ensureAIRequestBalance(env, revenueCatAppUserId, "summary");
    const balanceError = aiBillingError(balanceGate);
    if (balanceError) return balanceError;
  }

  // DB-first: check story_content.summary
  const stored = await getStorySummaryAndContent(env, storyId);
  log.info({ event: "ai_summary_db_check", storyId, hasSummary: Boolean(stored?.summary), hasExtractedText: Boolean(stored?.extractedText) });

  if (stored?.summary) {
    log.info({ event: "ai_summary_db_hit", storyId, source: "story_content.summary" });
    await new Promise((r) => setTimeout(r, 500)); // fake delay for DB hit
    await createPromptRunEvent(env, {
      source: "app_api",
      promptKind: "ai",
      promptKey: "summary",
      provider: "openai",
      model: AI_ACTIONS.summary.model,
      modality: "text",
      status: "cached",
      latencyMs: 500,
      cacheHit: true,
      requestExcerpt: JSON.stringify({ storyId }).slice(0, 500),
      responseExcerpt: String(stored.summary).slice(0, 500),
      storyId
    });
    if (alreadyCharged) {
      return json({ result: stored.summary, creditsUsed: 0, balanceAfter: null, cached: true, charged: false });
    }
    const charge = await finalizeAIRequestCharge(env, revenueCatAppUserId, "summary", `summary:${storyId}`, auth.cost);
    const chargeError = aiBillingError(charge);
    if (chargeError) return chargeError;
    await storeAIRequestReceipt(env, receiptKey);
    return json({ result: stored.summary, creditsUsed: auth.cost, balanceAfter: charge.balance, cached: true, charged: true });
  }

  if (!hasOpenAIConfig(env)) {
    return error("AI provider unavailable", 503, { code: "ai_provider_unavailable", provider: "openai" });
  }

  let result;
  let summaryTitle = body.title ?? "";
  const provider = await resolveAIProvider(env, "summary");

  if (provider === "cloudflare") {
    const articleUrl = await resolveArticleUrl(env, storyId, { url: body.url ?? null });
    if (articleUrl) {
      result = await generateSummaryViaCrawl(env, articleUrl, storyId, summaryTitle);
    } else {
      log.info({ event: "provider_fallback", provider: "cloudflare", fallback: "openai", reason: "no_url", storyId });
      const textToUse = stored?.extractedText || body.text || "";
      const article = textToUse
        ? { title: summaryTitle, text: textToUse }
        : await resolveArticleContent(env, storyId, { title: summaryTitle, text: "", url: null });
      summaryTitle = article.title || summaryTitle;
      result = await generateSummary(env, storyId, summaryTitle, article.text);
    }
  } else if (stored?.extractedText) {
    // Use extracted_text from DB instead of crawling
    log.info({ event: "ai_summary_using_extracted_text", storyId, textLength: stored.extractedText.length });
    result = await generateSummary(env, storyId, summaryTitle, stored.extractedText);
  } else {
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

  // Persist to story_content.summary for future DB-first hits
  await storeStorySummary(env, { storyId, sourceUrl: body.url ?? null, summary: result, updatedAt: now() });
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

  if (alreadyCharged) {
    return json({ result, creditsUsed: 0, balanceAfter: null, cached: false, charged: false });
  }
  const charge = await finalizeAIRequestCharge(env, revenueCatAppUserId, "summary", `summary:${storyId}`, auth.cost);
  const chargeError = aiBillingError(charge);
  if (chargeError) return chargeError;
  await storeAIRequestReceipt(env, receiptKey);
  return json({ result, creditsUsed: auth.cost, balanceAfter: charge.balance, cached: false, charged: true });
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

async function handleAIExplain(request, env) {
  const body = (await readJson(request.clone())) ?? {};
  // Always use technical (advanced) explain — simple mode is removed
  const actionKey = "explain_technical";
  const provider = await resolveAIProvider(env, actionKey);

  return handleStructuredCachedAIRequest(request, env, {
    actionKey,
    provider,
    buildPayload: async () => {
      const storyId = Number(body.storyId);

      if (provider === "cloudflare") {
        const articleUrl = await resolveArticleUrl(env, storyId, { url: body.url ?? null });
        if (articleUrl) {
          return buildExplainPayload({ ...body, storyId, title: body.title ?? "", text: "", url: articleUrl, level: "technical", _cfCrawl: true }, "technical");
        }
        log.info({ event: "provider_fallback", provider: "cloudflare", fallback: "openai", reason: "no_url", storyId, action: actionKey });
      }

      const article = await resolveArticleContent(env, storyId, {
        title: body.title ?? "",
        text: body.text ?? "",
        url: body.url ?? null
      });
      return buildExplainPayload({ ...body, storyId, title: article.title || (body.title ?? ""), text: article.text, level: "technical" }, "technical");
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
    persistResult: async (payload, result, responsePayload) => {
      // Save structured JSON for permanent DB-first lookup
      await storeStoryExplanationData(env, payload.storyId, responsePayload);
      await storeStoryExplanation(env, {
        storyId: payload.storyId,
        sourceUrl: payload.url ?? body.url ?? null,
        explanation: formatExplainResult(result),
        updatedAt: now()
      });
    },
    dbLookup: async (payload) => {
      const stored = await getStoryExplanationData(env, payload.storyId);
      if (!stored) return null;
      if (!stored.title || !Array.isArray(stored.sections) || !stored.sections.length) return null;
      log.info({ event: "ai_explain_db_hit", storyId: payload.storyId });
      return {
        title: stored.title,
        sections: stored.sections,
        followUps: stored.followUps ?? [],
        level: stored.level ?? "technical",
        contentHash: payload.contentHash
      };
    },
    cacheDelay: 1000,
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

// ── Admin helpers ─────────────────────────────────────────────────────────────

function requireAdminKey(request, env) {
  const secret = env.ADMIN_API_KEY;
  if (!secret) return error("Admin endpoint not configured", 503);
  const token = bearerToken(request);
  if (!token || token !== secret) return error("Unauthorized", 401);
  return null;
}

async function handleAdminTestPrompt(request, env) {
  const authErr = requireAdminKey(request, env);
  if (authErr) return authErr;

  const body = await readJson(request);
  if (!body) return error("Invalid JSON body", 400);

  const start = Date.now();

  // ── Resolve content ──────────────────────────────────────────────────────
  let title = "";
  let articleText = "";
  let sourceKind = "provided";
  let crawlMetadata = null;

  if (body.storyId) {
    const resolved = await resolveArticleContent(env, body.storyId, {
      title: body.title ?? "",
      url: body.url ?? null
    }, { allowCrawl: false });
    title = resolved.title || body.title || "";
    articleText = resolved.text || "";
    sourceKind = resolved.sourceKind ?? "cache";
    crawlMetadata = resolved.metadata ?? null;
    if (!articleText && body.url) {
      const withCrawl = await resolveArticleContent(env, body.storyId, {
        title: body.title ?? "",
        url: body.url
      });
      title = withCrawl.title || title;
      articleText = withCrawl.text || "";
      sourceKind = withCrawl.sourceKind ?? sourceKind;
      crawlMetadata = withCrawl.metadata ?? crawlMetadata;
    }
  } else if (body.url) {
    const crawlResult = await crawlUrl(env, body.url);
    if (crawlResult.success && crawlResult.markdown) {
      articleText = crawlResult.markdown;
      sourceKind = "crawl";
      crawlMetadata = crawlResult.metadata ?? null;
      title = crawlMetadata?.title || body.title || "";
    } else {
      return error("Crawl failed", 422, { crawlError: crawlResult.error ?? "unknown" });
    }
  } else {
    title = body.title || "";
    articleText = body.text || "";
    sourceKind = "provided";
  }

  if (!title && !articleText) {
    return error("No content to generate from. Provide storyId, url, or title/text.", 400);
  }

  // ── Resolve template ────────────────────────────────────────────────────
  let template;
  if (body.templateText) {
    template = {
      id: null,
      name: "adhoc",
      templateText: body.templateText,
      provider: body.provider ?? "fal",
      model: body.model ?? null,
      settings: body.settings ?? {},
      modality: "image"
    };
  } else if (body.templateId) {
    const dbTemplate = await getPromptTemplateById(env, body.templateId);
    if (!dbTemplate) return error("Template not found", 404);
    template = dbTemplate;
    if (body.provider) template.provider = body.provider;
    if (body.model) template.model = body.model;
    if (body.settings) template.settings = { ...template.settings, ...body.settings };
  } else {
    template = mediaTemplateWithFallback(null, "image");
    if (body.provider) template.provider = body.provider;
    if (body.model) template.model = body.model;
    if (body.settings) template.settings = { ...template.settings, ...body.settings };
  }

  template = mediaTemplateWithFallback(template, "image");

  // ── Build prompt ────────────────────────────────────────────────────────
  const resolvedPrompt = buildPromptInput(template.templateText, {
    title,
    sourceText: clipPromptText(articleText, 1200)
  });

  // ── Generate image ──────────────────────────────────────────────────────
  const genStart = Date.now();
  const result = await generateImageWithProvider(env, {
    provider: template.provider,
    model: template.model,
    settings: template.settings,
    prompt: resolvedPrompt,
    storyId: body.storyId ?? null
  });
  const latencyMs = Date.now() - genStart;

  // ── Optional R2 upload ──────────────────────────────────────────────────
  let r2Url = null;
  if (body.uploadToR2 && result.status === "ready" && result.url && env.MEDIA_BUCKET?.put) {
    const imageResponse = await fetch(result.url);
    if (imageResponse.ok) {
      const key = `test-prompts/${Date.now()}.webp`;
      await env.MEDIA_BUCKET.put(key, imageResponse.body, {
        httpMetadata: { contentType: imageResponse.headers.get("content-type") ?? "image/webp" }
      });
      r2Url = publicMediaUrlFor(env, key);
    }
  }

  // ── Optional prompt run event ───────────────────────────────────────────
  let promptRunEventId = null;
  if (body.logPromptRun !== false) {
    try {
      const eventResult = await createPromptRunEvent(env, {
        source: "admin_test_prompt",
        promptKind: "media",
        promptKey: template.name ?? "adhoc",
        promptTemplateId: template.id ?? null,
        provider: result.provider ?? template.provider ?? "fal",
        model: result.model ?? template.model ?? null,
        modality: "image",
        status: result.status === "ready" ? "ready" : "failed",
        latencyMs,
        requestExcerpt: resolvedPrompt.slice(0, 500),
        responseExcerpt: result.url ?? null,
        artifactUrl: result.url ?? null,
        errorText: result.errorText ?? null,
        storyId: body.storyId ?? null
      });
      promptRunEventId = eventResult?.id ?? null;
    } catch (err) {
      log.warn({ event: "test_prompt_log_fail", ...log.fmtError(err) });
    }
  }

  return json({
    status: result.status,
    imageUrl: result.url ?? null,
    r2Url,
    provider: result.provider ?? template.provider,
    model: result.model ?? template.model,
    resolvedPrompt,
    templateUsed: {
      id: template.id,
      name: template.name,
      templateText: template.templateText
    },
    settings: template.settings,
    resolvedContent: {
      title,
      textLength: articleText.length,
      sourceKind,
      metadata: crawlMetadata
    },
    latencyMs,
    totalMs: Date.now() - start,
    error: result.errorText ?? null,
    promptRunEventId,
    billableUnits: result.billableUnits ?? null
  });
}

const ROUTES = [
  { method: "GET",   path: "/health",               name: "health",           handler: (r, e) => json({ ok: true, service: e.APP_NAME ?? "NewsRoll Backend", environment: e.ENVIRONMENT ?? "unknown" }) },
  { method: "GET",   path: "/v1/config",             name: "config",           handler: handleConfig },
  { method: "GET",   path: "/v1/visual-feed",        name: "visual_feed",      handler: handleVisualFeed },
  { method: "POST",  path: "/v1/events",             name: "events",          handler: handleEvents },
  { method: "POST",  path: "/v1/ai/summary",          name: "ai_summary",      handler: handleAISummary },
  { method: "POST",  path: "/v1/ai/translate",         name: "ai_translate",    handler: handleAITranslate },
  { method: "POST",  path: "/v1/ai/explain",           name: "ai_explain",      handler: handleAIExplain },
  { method: "GET",   path: "/v1/credits",              name: "credits",         handler: handleGetCredits },
  { method: "POST",  path: "/admin/test-prompt",       name: "admin_test_prompt", handler: handleAdminTestPrompt },
];

async function routeRequest(request, env, ctx) {
  const url = new URL(request.url);
  const segments = url.pathname.split("/").filter(Boolean);

  if (request.method === "OPTIONS") {
    return { response: new Response(null, { status: 204, headers: buildCorsHeaders(request) }), route: "cors_preflight" };
  }

  for (const route of ROUTES) {
    if (request.method === route.method && url.pathname === route.path) {
      const response = await route.handler(request, env, ctx);
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
  async fetch(request, env, ctx) {
    const start = Date.now();
    const rid = log.requestId(request);
    const meta = log.requestMeta(request);
    try {
      const { response, route } = await routeRequest(request, env, ctx);
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
