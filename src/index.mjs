import { buildAppConfig, publicApiBaseUrl, publicMediaUrlFor } from "./config.mjs";
import {
  getReadableContent,
  getAIPromptConfig,
  getCachedAIResult,
  createPromptRunEvent,
  hasAIRequestReceipt,
  listPublishedVisualFeed,
  getPublishedFeedEntriesByStoryIds,
  getLatestPublishedVisualFeedSnapshot,
  storeStoryExplanation,
  storeStoryExplanationData,
  getStoryExplanationData,
  getStorySummaryAndContent,
  storeStorySummary,
  storeReadableContent,
  replaceStoryContent,
  storeHeadline,
  storeAIRequestReceipt,
  storeCachedAIResult,
  createImagePromptGeneration,
  resolveImagePromptOptimizerConfig,
  upsertMedia,
  updatePublishedFeedEntry,
  updatePublishedFeedEntryMediaProjection,
  getMaxStoryId,
  getMaxPublishedVisualFeedSequence,
  publishReadyStory,
  storeStory,
  getStoryContentMetadataByStoryId,
  getAdminStoryCurrentData
} from "./db.mjs";
import { error, json, readJson, bearerToken } from "./http.mjs";
import * as log from "./log.mjs";

import { verifySupabaseJWT } from "./security.mjs";
import {
  buildVisualFeedResponse,
  makePublishedVisualFeedRow,
  mergeVisualFeedSnapshot,
  parseVisualFeedCursor,
  parseVisualFeedLimit,
  readVisualFeedSnapshot,
  toVisualFeedItem,
  writeVisualFeedSnapshot
} from "./visual-feed.mjs";
import { validateEventBatch, storeEvents } from "./events.mjs";
import { handleLandingLead } from "./landing-leads.mjs";
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
import { promptConfigWithFallback } from "./prompt-config.mjs";
import { generateImageWithProvider } from "./media-generation.mjs";
import { crawlWithFallback } from "./crawl-provider.mjs";
import { queryPersonalizedFeed, upsertItem as upsertShapedItem } from "./shaped.mjs";
import {
  DEFAULT_IMAGE_PROMPT_OPTIMIZER_KEY,
  buildImagePromptOptimizerInput,
  generateOptimizedImagePrompt
} from "./image-prompt-optimizer.mjs";

function now() {
  return new Date().toISOString();
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function adminDryRunEnabled(body) {
  return body?.dryRun === true;
}

function adminReplaceStoryContentEnabled(body) {
  return body?.replaceStoryContent === true;
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

function clipAdminPreviewText(value, maxLength = 1200) {
  const normalized = normalizeText(value);
  return normalized ? normalized.slice(0, maxLength) : "";
}

function mediaExtensionFromContentType(contentType, fallback = "webp") {
  const normalized = normalizeText(contentType).toLowerCase();
  if (normalized.includes("png")) return "png";
  if (normalized.includes("jpeg") || normalized.includes("jpg")) return "jpg";
  if (normalized.includes("webp")) return "webp";
  if (normalized.includes("gif")) return "gif";
  return fallback;
}

function mediaKeyFromPublicUrl(env, mediaUrl) {
  const normalizedUrl = normalizeText(mediaUrl);
  if (!normalizedUrl) {
    return null;
  }

  const prefixes = [];
  if (env?.PUBLIC_MEDIA_BASE_URL) {
    prefixes.push(`${String(env.PUBLIC_MEDIA_BASE_URL).replace(/\/+$/, "")}/`);
  }
  prefixes.push(`${publicApiBaseUrl(env)}/media/`);

  for (const prefix of prefixes) {
    if (normalizedUrl.startsWith(prefix)) {
      const mediaKey = normalizedUrl.slice(prefix.length).replace(/^\/+/, "");
      return mediaKey || null;
    }
  }

  return null;
}

function decodeBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function readAssetPayload(assetUrl) {
  const normalizedUrl = normalizeText(assetUrl);
  if (!normalizedUrl) {
    throw new Error("Missing asset URL");
  }

  if (normalizedUrl.startsWith("data:")) {
    const match = normalizedUrl.match(/^data:([^;,]+)?(?:;base64)?,(.*)$/s);
    if (!match) {
      throw new Error("Unsupported data URL");
    }
    const [, contentType = "application/octet-stream", rawPayload = ""] = match;
    const isBase64 = normalizedUrl.includes(";base64,");
    const bytes = isBase64
      ? decodeBase64(rawPayload)
      : new TextEncoder().encode(decodeURIComponent(rawPayload));
    return {
      bytes,
      contentType,
      sourceUrl: normalizedUrl
    };
  }

  const response = await fetch(normalizedUrl);
  if (!response.ok) {
    throw new Error(`Asset fetch failed: HTTP ${response.status}`);
  }

  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    contentType: response.headers.get("content-type") ?? "application/octet-stream",
    sourceUrl: normalizedUrl
  };
}

function adminTestAssetKeys(storyId, runId, extension) {
  const storyPart = Number.isInteger(Number(storyId)) && Number(storyId) > 0 ? String(storyId) : "adhoc";
  return {
    assetKey: `test-prompts/${storyPart}/${runId}.${extension}`,
    manifestKey: `test-prompts/${storyPart}/${runId}.json`
  };
}

async function writeAdminTestAsset(env, payload) {
  if (!env.MEDIA_BUCKET?.put) {
    return null;
  }

  const runId = crypto.randomUUID();
  const assetPayload = await readAssetPayload(payload.assetUrl);
  const extension = mediaExtensionFromContentType(assetPayload.contentType);
  const keys = adminTestAssetKeys(payload.storyId, runId, extension);

  await env.MEDIA_BUCKET.put(keys.assetKey, assetPayload.bytes, {
    httpMetadata: { contentType: assetPayload.contentType }
  });

  const manifest = {
    version: 1,
    runId,
    createdAt: now(),
    storyId: payload.storyId ?? null,
    sourceEndpoint: payload.sourceEndpoint ?? null,
    sourceUrl: payload.sourceUrl ?? null,
    title: payload.title ?? "",
    articleText: payload.articleText ?? "",
    sourceKind: payload.sourceKind ?? null,
    crawlMetadata: payload.crawlMetadata ?? null,
    resolvedPrompt: payload.resolvedPrompt ?? "",
    optimizerUsed: payload.optimizerUsed ?? null,
    optimizerInput: payload.optimizerInput ?? null,
    promptGenerationId: payload.promptGenerationId ?? null,
    imageGenerationSettings: payload.imageGenerationSettings ?? {},
    provider: payload.provider ?? null,
    model: payload.model ?? null,
    generationProvider: payload.generationProvider ?? payload.provider ?? null,
    generationModel: payload.generationModel ?? payload.model ?? null,
    latencyMs: payload.latencyMs ?? null,
    billableUnits: payload.billableUnits ?? null,
    assetKey: keys.assetKey,
    assetContentType: assetPayload.contentType
  };

  await env.MEDIA_BUCKET.put(keys.manifestKey, JSON.stringify(manifest, null, 2), {
    httpMetadata: { contentType: "application/json; charset=utf-8" }
  });

  return {
    ...manifest,
    manifestKey: keys.manifestKey,
    assetUrl: publicMediaUrlFor(env, keys.assetKey)
  };
}

async function readAdminTestManifest(env, manifestKey) {
  if (!env.MEDIA_BUCKET?.get) {
    throw new Error("MEDIA_BUCKET binding is required to apply a saved test");
  }

  const object = await env.MEDIA_BUCKET.get(manifestKey);
  if (!object) {
    throw new Error("Saved test manifest not found");
  }

  return object.json();
}

async function refreshPublishedFeedSnapshot(env, publishedEntry) {
  const currentSnapshot =
    (await readVisualFeedSnapshot(env)) ??
    (await getLatestPublishedVisualFeedSnapshot(env));

  const nextRow = makePublishedVisualFeedRow(env, {
    storyId: publishedEntry.storyId,
    publishSequence: publishedEntry.publishSequence,
    sourceEndpoint: publishedEntry.sourceEndpoint,
    publishedAt: publishedEntry.publishedAt,
    mediaUrl: publishedEntry.mediaUrl,
    mediaStatus: publishedEntry.mediaStatus,
    headline: publishedEntry.headline
  });

  await writeVisualFeedSnapshot(env, mergeVisualFeedSnapshot(currentSnapshot ?? [], nextRow));
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

async function buildTranslationPayload(body) {
  const storyId = Number(body.storyId);
  const targetLanguage = normalizeText(body.targetLanguage);
  const story = normalizeTranslationStory(storyId, body.story);
  const comments = normalizeStructuredComments(body.comments);
  const source = {
    storyId,
    targetLanguage,
    story,
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
  if (result?.error === "credit_spend_failed") {
    return error("Credit spend failed", 503, { code: "credit_spend_failed" });
  }
  if (result?.error) {
    return error(result.error, 500);
  }
  return null;
}

async function hasAIRequestReceiptSafe(env, receiptKey, action) {
  try {
    return { ok: true, alreadyCharged: await hasAIRequestReceipt(env, receiptKey) };
  } catch (err) {
    log.warn({
      event: "ai_receipt_lookup_fail",
      action,
      storyId: receiptKey?.storyId,
      subscriberId: receiptKey?.subscriberId,
      ...log.fmtError(err)
    });
    return { ok: false, response: error("AI receipt lookup unavailable", 503, { code: "ai_receipt_lookup_unavailable" }) };
  }
}

async function bestEffort(env, event, operation) {
  try {
    await operation();
  } catch (err) {
    log.warn({ event, ...log.fmtError(err) });
  }
}

function withRequestId(response, requestId) {
  const headers = new Headers(response.headers);
  headers.set("x-request-id", requestId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

const ALLOWED_ORIGINS = [
  "https://newsroll.app",
  "https://www.newsroll.app",
  "http://localhost:5173"
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
  const cursorRaw = url.searchParams.get("cursor");
  const limit = parseVisualFeedLimit(env, url.searchParams.get("limit"));
  const user = await userContext(request, env);

  // Personalized path for authenticated users via Shaped
  if (user?.userId) {
    const paginationKey = cursorRaw || `${user.userId}_${Date.now()}`;
    const shaped = await queryPersonalizedFeed(env, user.userId, { count: limit, paginationKey });

    if (shaped.results.length > 0) {
      const enriched = await getPublishedFeedEntriesByStoryIds(env, shaped.results.map((r) => r.id));
      const shapedCount = shaped.results.length;
      const enrichedCount = enriched.length;
      const dropped = shapedCount - enrichedCount;

      // Fall through to the global feed when Shaped's catalog has drifted from
      // published_feed_entries and we can't assemble a reasonable page. Without
      // this, the app can receive a tiny list (e.g. 1 item) with nextCursor=null
      // and treat the feed as ended.
      const minEnrichedCount = Math.min(5, Math.ceil(limit / 2));
      if (enrichedCount < minEnrichedCount) {
        log.warn({
          event: "visual_feed_shaped_enrichment_low",
          userId: user.userId,
          shapedCount,
          enrichedCount,
          dropped,
          limit,
          minEnrichedCount,
          action: "fallthrough_to_global"
        });
      } else {
        if (dropped > 0) {
          log.info({
            event: "visual_feed_shaped_enrichment_dropped",
            userId: user.userId,
            shapedCount,
            enrichedCount,
            dropped,
            limit
          });
        }
        const nextCursor = shaped.paginationKey && shapedCount >= limit ? shaped.paginationKey : null;
        return json(
          {
            cursor: cursorRaw ?? null,
            nextCursor,
            items: enriched.map((row) => toVisualFeedItem(env, row))
          },
          { headers: { "cache-control": "private, max-age=30" } }
        );
      }
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
  const receiptLookup = await hasAIRequestReceiptSafe(env, receiptKey, "summary");
  if (!receiptLookup.ok) return receiptLookup.response;
  const alreadyCharged = receiptLookup.alreadyCharged;
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
    const provider = await resolveAIProvider(env, "summary");
    await bestEffort(env, "ai_summary_prompt_run_event_fail", () => createPromptRunEvent(env, {
      source: "app_api",
      promptKind: "ai",
      promptKey: "summary",
      provider,
      model: AI_ACTIONS.summary.model,
      modality: "text",
      status: "cached",
      latencyMs: 500,
      cacheHit: true,
      requestExcerpt: JSON.stringify({ storyId }).slice(0, 500),
      responseExcerpt: String(stored.summary).slice(0, 500),
      storyId
    }));
    if (alreadyCharged) {
      return json({ result: stored.summary, creditsUsed: 0, balanceAfter: null, cached: true, charged: false });
    }
    const charge = await finalizeAIRequestCharge(env, revenueCatAppUserId, "summary", `summary:${storyId}`, auth.cost);
    const chargeError = aiBillingError(charge);
    if (chargeError) return chargeError;
    await storeAIRequestReceipt(env, receiptKey);
    return json({ result: stored.summary, creditsUsed: auth.cost, balanceAfter: charge.balance, cached: true, charged: true });
  }

  const provider = await resolveAIProvider(env, "summary");
  if (provider !== "cloudflare" && !hasOpenAIConfig(env)) {
    return error("AI provider unavailable", 503, { code: "ai_provider_unavailable", provider: "openai" });
  }

  let result;
  let summaryTitle = body.title ?? "";

  if (provider === "cloudflare") {
    const articleUrl = await resolveArticleUrl(env, storyId, { url: body.url ?? null });
    if (articleUrl) {
      result = await generateSummaryViaCrawl(env, articleUrl, storyId, summaryTitle);
    } else {
      if (!hasOpenAIConfig(env)) {
        log.warn({
          event: "ai_provider_unavailable",
          provider: "openai",
          action: "summary",
          reason: "cloudflare_summary_requires_url_for_crawl",
          storyId
        });
        return error("AI provider unavailable", 503, {
          code: "ai_provider_unavailable",
          provider: "openai",
          reason: "cloudflare_summary_requires_url_for_crawl"
        });
      }
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
    await bestEffort(env, "ai_summary_prompt_run_event_fail", () => createPromptRunEvent(env, {
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
    }));
    return error("AI generation failed", 502);
  }

  // Persist to story_content.summary for future DB-first hits
  await bestEffort(env, "ai_summary_store_fail", () => storeStorySummary(env, { storyId, sourceUrl: body.url ?? null, summary: result, updatedAt: now() }));
  await bestEffort(env, "ai_summary_prompt_run_event_fail", () => createPromptRunEvent(env, {
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
  }));

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

  const payload = await buildTranslationPayload(body);
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

// ── Async Crawl Tasks ──────────────────────────────────────────────────────

const CRAWL_TASK_KV_PREFIX = "crawl-task:";
const CRAWL_TASK_TTL_SECONDS = 3600; // 1 hour

function crawlTaskKvKey(taskId) {
  return `${CRAWL_TASK_KV_PREFIX}${taskId}`;
}

async function readCrawlTask(env, taskId) {
  if (!env.VISUAL_FEED_CACHE?.get) return null;
  const raw = await env.VISUAL_FEED_CACHE.get(crawlTaskKvKey(taskId));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function writeCrawlTask(env, taskId, data) {
  if (!env.VISUAL_FEED_CACHE?.put) return;
  await env.VISUAL_FEED_CACHE.put(crawlTaskKvKey(taskId), JSON.stringify(data), { expirationTtl: CRAWL_TASK_TTL_SECONDS });
}

async function runCrawlTask(env, taskId, { url, storyId, forceFirecrawl }) {
  try {
    const crawlResult = await crawlWithFallback(env, url, { storyId, recrawl: true, forceFirecrawl });
    if (crawlResult.success && crawlResult.markdown) {
      await writeCrawlTask(env, taskId, {
        status: "completed",
        url,
        storyId: storyId ?? null,
        markdown: crawlResult.markdown,
        metadata: crawlResult.metadata ?? null,
        crawlProvider: crawlResult.crawlProvider ?? null,
        cfError: crawlResult.cfError ?? null,
        cfFailureKind: crawlResult.cfFailureKind ?? null,
        completedAt: now()
      });
    } else {
      await writeCrawlTask(env, taskId, {
        status: "failed",
        url,
        storyId: storyId ?? null,
        error: crawlResult.error ?? "unknown",
        crawlProvider: crawlResult.crawlProvider ?? null,
        cfError: crawlResult.cfError ?? null,
        cfFailureKind: crawlResult.cfFailureKind ?? null,
        completedAt: now()
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ event: "crawl_task_error", taskId, url, error: message });
    await writeCrawlTask(env, taskId, {
      status: "failed",
      url,
      storyId: storyId ?? null,
      error: message,
      crawlProvider: null,
      cfError: null,
      cfFailureKind: null,
      completedAt: now()
    });
  }
}

async function handleAdminMediaCrawl(request, env, ctx) {
  const authErr = requireAdminKey(request, env);
  if (authErr) return authErr;

  const body = await readJson(request);
  if (!body) return error("Invalid JSON body", 400);

  const url = normalizeText(body.url);
  if (!url) return error("url is required", 400);

  const storyId = Number.isInteger(Number(body.storyId)) && Number(body.storyId) > 0
    ? Number(body.storyId) : null;
  const forceFirecrawl = body.forceFirecrawl === true;

  const taskId = crypto.randomUUID();
  await writeCrawlTask(env, taskId, {
    status: "running",
    url,
    storyId,
    forceFirecrawl,
    startedAt: now()
  });

  const crawlPromise = runCrawlTask(env, taskId, { url, storyId, forceFirecrawl });
  if (ctx?.waitUntil) {
    ctx.waitUntil(crawlPromise);
  }

  return json({
    crawlTaskId: taskId,
    status: "running",
    url,
    storyId,
    forceFirecrawl
  });
}

async function handleAdminMediaCrawlStatus(env, taskId) {
  const task = await readCrawlTask(env, taskId);
  if (!task) return error("Crawl task not found or expired", 404);
  return json({ crawlTaskId: taskId, ...task });
}

async function handleAdminStoryCurrentData(env, pathStoryId) {
  const storyId = Number(pathStoryId);
  if (!Number.isInteger(storyId) || storyId <= 0) {
    return error("Invalid storyId in path", 400);
  }

  const snapshot = await getAdminStoryCurrentData(env, storyId);
  if (!snapshot) {
    return error("Story data not found", 404, { storyId });
  }

  return json(snapshot);
}

async function resolveAdminTestContent(env, body, { persistCrawlResult = true } = {}) {
  let title = "";
  let articleText = "";
  let sourceKind = "provided";
  let crawlMetadata = null;
  let crawlProvider = null;
  let cfError = null;
  let cfFailureKind = null;
  let sourceUrl = normalizeText(body.url);
  const recrawl = body.recrawl === true;
  const forceFirecrawl = body.forceFirecrawl === true;

  // ── Use pre-crawled content from async crawl task ──
  if (body.crawlTaskId) {
    const task = await readCrawlTask(env, body.crawlTaskId);
    if (!task) {
      throw Object.assign(new Error("Crawl task not found or expired"), { status: 404 });
    }
    if (task.status === "running") {
      throw Object.assign(new Error("Crawl task is still running"), { status: 202, details: { crawlTaskId: body.crawlTaskId, status: "running" } });
    }
    if (task.status === "failed") {
      throw Object.assign(new Error("Crawl task failed"), {
        status: 422,
        details: { crawlTaskId: body.crawlTaskId, crawlError: task.error ?? "unknown", crawlProvider: task.crawlProvider ?? null, cfError: task.cfError ?? null, cfFailureKind: task.cfFailureKind ?? null }
      });
    }
    // task.status === "completed"
    articleText = task.markdown ?? "";
    crawlMetadata = task.metadata ?? null;
    crawlProvider = task.crawlProvider ?? null;
    cfError = task.cfError ?? null;
    cfFailureKind = task.cfFailureKind ?? null;
    sourceUrl = task.url || sourceUrl || null;
    sourceKind = "crawl";
    title = body.title || crawlMetadata?.title || "";

    return {
      title,
      articleText,
      sourceKind,
      crawlMetadata,
      crawlProvider,
      cfError,
      cfFailureKind,
      sourceUrl: sourceUrl || null
    };
  }

  // Look up story URL from DB when recrawl/forceFirecrawl requested without explicit URL
  if (body.storyId && !sourceUrl && (recrawl || forceFirecrawl)) {
    const storyMeta = await getStoryContentMetadataByStoryId(env, Number(body.storyId));
    sourceUrl = storyMeta?.canonicalUrl || storyMeta?.url || "";
  }

  if (body.storyId) {
    if ((recrawl || forceFirecrawl) && sourceUrl) {
      // Force re-crawl or force Firecrawl: bypass cache, go straight to crawl
      const crawlResult = await crawlWithFallback(env, sourceUrl, { storyId: Number(body.storyId), recrawl: true, forceFirecrawl });
      crawlProvider = crawlResult.crawlProvider ?? null;
      cfError = crawlResult.cfError ?? null;
      cfFailureKind = crawlResult.cfFailureKind ?? null;
      if (crawlResult.success && crawlResult.markdown) {
        articleText = crawlResult.markdown;
        sourceKind = "crawl";
        crawlMetadata = crawlResult.metadata ?? null;
        title = body.title || crawlMetadata?.title || "";
      } else {
        throw Object.assign(new Error(forceFirecrawl ? "Firecrawl failed" : "Recrawl failed"), {
          status: 422,
          details: { crawlError: crawlResult.error ?? "unknown", crawlProvider, cfError, cfFailureKind }
        });
      }
    } else if (recrawl) {
      // recrawl without URL: resolve with cache bypass
      const resolved = await resolveArticleContent(env, body.storyId, {
        title: body.title ?? "",
        text: body.text ?? "",
        url: sourceUrl || null
      }, { allowCrawl: true, recrawl: true, persistCrawlResult });
      title = resolved.title || body.title || "";
      articleText = resolved.text || "";
      sourceKind = resolved.sourceKind ?? "crawl";
      crawlMetadata = resolved.metadata ?? null;
    } else {
      const resolved = await resolveArticleContent(env, body.storyId, {
        title: body.title ?? "",
        text: body.text ?? "",
        url: sourceUrl || null
      }, { allowCrawl: false });
      title = resolved.title || body.title || "";
      articleText = resolved.text || "";
      sourceKind = resolved.sourceKind ?? "cache";
      crawlMetadata = resolved.metadata ?? null;

      if (!articleText && sourceUrl) {
        const withCrawl = await resolveArticleContent(env, body.storyId, {
          title: body.title ?? "",
          text: body.text ?? "",
          url: sourceUrl
        }, { persistCrawlResult });
        title = withCrawl.title || title;
        articleText = withCrawl.text || "";
        sourceKind = withCrawl.sourceKind ?? sourceKind;
        crawlMetadata = withCrawl.metadata ?? crawlMetadata;
      }
    }
  } else if (sourceUrl) {
    const crawlResult = await crawlWithFallback(env, sourceUrl, { recrawl, forceFirecrawl });
    crawlProvider = crawlResult.crawlProvider ?? null;
    cfError = crawlResult.cfError ?? null;
    cfFailureKind = crawlResult.cfFailureKind ?? null;
    if (crawlResult.success && crawlResult.markdown) {
      articleText = crawlResult.markdown;
      sourceKind = "crawl";
      crawlMetadata = crawlResult.metadata ?? null;
      title = body.title || crawlMetadata?.title || "";
    } else {
      throw Object.assign(new Error("Crawl failed"), {
        status: 422,
        details: { crawlError: crawlResult.error ?? "unknown", crawlProvider, cfError, cfFailureKind }
      });
    }
  } else {
    title = body.title || crawlMetadata?.title || "";
    articleText = body.text || "";
    sourceKind = "provided";
  }

  if (!title && !articleText) {
    throw Object.assign(new Error("No content to generate from. Provide storyId, url, or title/text."), {
      status: 400
    });
  }

  if (body.storyId && (!crawlMetadata || !Array.isArray(crawlMetadata?.topics) || !crawlMetadata?.summary || !crawlMetadata?.headline)) {
    const storedStoryContent = await getStorySummaryAndContent(env, Number(body.storyId));
    if (storedStoryContent) {
      crawlMetadata = {
        ...(crawlMetadata ?? {}),
        headline: crawlMetadata?.headline ?? storedStoryContent.aiHeadline ?? null,
        summary: crawlMetadata?.summary ?? storedStoryContent.summary ?? null,
        topics: Array.isArray(crawlMetadata?.topics) && crawlMetadata.topics.length > 0
          ? crawlMetadata.topics
          : (Array.isArray(storedStoryContent.topics) ? storedStoryContent.topics : [])
      };
    }
  }

  return {
    title,
    articleText,
    sourceKind,
    crawlMetadata,
    crawlProvider,
    cfError,
    cfFailureKind,
    sourceUrl: sourceUrl || null
  };
}

async function resolveAdminOptimizerConfig(env, body) {
  const optimizerConfigId = Number(body.optimizerConfigId);
  const optimizerInput = buildAdminOptimizerInput(body.__resolvedContentForOptimizer ?? {});
  if (Number.isInteger(optimizerConfigId) && optimizerConfigId > 0) {
    return resolveImagePromptOptimizerConfig(env, {
      id: optimizerConfigId
    });
  }

  const optimizerKey = normalizeText(body.optimizerKey);
  const optimizerVersion = normalizeText(body.optimizerVersion);
  if (optimizerKey || optimizerVersion) {
    return resolveImagePromptOptimizerConfig(env, {
      key: optimizerKey || DEFAULT_IMAGE_PROMPT_OPTIMIZER_KEY,
      version: optimizerVersion || null,
      input: optimizerInput
    });
  }

  return resolveImagePromptOptimizerConfig(env, {
    key: null,
    input: optimizerInput
  });
}

function buildAdminOptimizerInput(resolvedContent) {
  return buildImagePromptOptimizerInput({
    title: resolvedContent.title,
    headline: resolvedContent.crawlMetadata?.headline ?? "",
    summary: resolvedContent.crawlMetadata?.summary ?? "",
    topics: resolvedContent.crawlMetadata?.topics ?? [],
    language: resolvedContent.crawlMetadata?.language ?? "en",
    markdown: resolvedContent.articleText ?? ""
  });
}

async function runAdminPromptOptimization(env, body, resolvedContent, storyId, source, { persistPromptGeneration = true } = {}) {
  const optimizerInput = buildAdminOptimizerInput(resolvedContent);
  const optimizerSelection = await resolveAdminOptimizerConfig(env, {
    ...body,
    __resolvedContentForOptimizer: resolvedContent
  });
  const optimizerConfig = optimizerSelection.config;
  const optimization = await generateOptimizedImagePrompt(env, optimizerInput, {
    config: optimizerConfig,
    storyId
  });
  const promptGenerationId = persistPromptGeneration
    ? await createImagePromptGeneration(env, {
      storyId,
      source,
      optimizerConfigId: optimizerConfig.id ?? null,
      optimizerKey: optimizerConfig.key,
      optimizerVersion: optimizerConfig.version,
      optimizerProvider: optimization.provider ?? optimizerConfig.optimizerProvider,
      optimizerModel: optimization.model ?? optimizerConfig.optimizerModel,
      optimizerInput,
      optimizedPrompt: optimization.optimizedPrompt,
      status: optimization.status,
      latencyMs: optimization.latencyMs,
      errorText: optimization.errorText
    })
    : null;

  return {
    optimizerConfig,
    optimizerSelection,
    optimizerInput,
    optimization,
    promptGenerationId
  };
}

function adminImageGenerationOptions(body, optimizerConfig = null) {
  const providerOverride = normalizeText(body.provider);
  const modelOverride = normalizeText(body.model);
  const defaultProvider = normalizeText(optimizerConfig?.generationProvider) || "fal";
  return {
    provider: providerOverride || defaultProvider,
    model: modelOverride || (providerOverride ? null : (normalizeText(optimizerConfig?.generationModel) || null)),
    settings: body.settings && typeof body.settings === "object" ? body.settings : null
  };
}

function buildOptimizerUsedPayload(optimized) {
  return {
    id: optimized.optimizerConfig.id,
    key: optimized.optimizerConfig.key,
    version: optimized.optimizerConfig.version,
    name: optimized.optimizerConfig.name,
    optimizerProvider: optimized.optimizerConfig.optimizerProvider,
    optimizerModel: optimized.optimizerConfig.optimizerModel,
    generationProvider: optimized.optimizerConfig.generationProvider,
    generationModel: optimized.optimizerConfig.generationModel,
    matchedTopics: optimized.optimizerSelection?.matchedTopics ?? [],
    matchedKeywords: optimized.optimizerSelection?.matchedKeywords ?? [],
    fallbackReason: optimized.optimizerSelection?.fallbackReason ?? null
  };
}

async function applyApprovedAdminTest(env, body) {
  const manifestKey = normalizeText(body.testManifestKey);
  if (!manifestKey) {
    return error("testManifestKey is required", 400);
  }

  const manifest = await readAdminTestManifest(env, manifestKey);
  const storyId = Number(manifest.storyId);
  if (!Number.isInteger(storyId) || storyId <= 0) {
    return error("Saved test manifest is missing a valid storyId", 422);
  }

  if (body.storyId != null && Number(body.storyId) !== storyId) {
    return error("storyId does not match the saved test manifest", 409);
  }

  const existingEntry = (await getPublishedFeedEntriesByStoryIds(env, [storyId]))[0] ?? null;
  if (!existingEntry) {
    return error("Published feed item not found for storyId", 404);
  }

  if (!env.MEDIA_BUCKET?.get || !env.MEDIA_BUCKET?.put) {
    return error("MEDIA_BUCKET binding is required to apply a saved test", 503);
  }
  const applied = await applyAdminManifestToStory(env, {
    storyId,
    existingEntry,
    manifest,
    replaceStoredContent: adminReplaceStoryContentEnabled(body),
    requestIdPrefix: "admin_test"
  });

  return json({
    ok: true,
    storyId,
    applied: true,
    testManifestKey: manifestKey,
    mediaKey: applied.mediaKey,
    mediaUrl: applied.mediaUrl,
    publishedEntry: {
      storyId,
      publishSequence: existingEntry.publishSequence,
      publishedAt: existingEntry.publishedAt,
      sourceEndpoint: existingEntry.sourceEndpoint,
      mediaStatus: "ready",
      headline: applied.headline
    },
    contentUpdated: {
      readableContent: Boolean(applied.articleText),
      headline: Boolean(applied.headline),
      summary: Boolean(applied.summary),
      topics: Array.isArray(applied.topics) ? applied.topics.length : 0
    },
    replacedStoryContent: adminReplaceStoryContentEnabled(body),
    shaped: applied.shapedResult
  });
}

async function applyAdminManifestToStory(env, {
  storyId,
  existingEntry,
  manifest,
  replaceStoredContent = false,
  requestIdPrefix = "admin_apply"
}) {
  const assetObject = await env.MEDIA_BUCKET.get(manifest.assetKey);
  if (!assetObject) {
    throw Object.assign(new Error("Saved test asset not found"), { status: 404 });
  }

  const articleText = typeof manifest.articleText === "string" ? manifest.articleText : "";
  const fallbackText = `${manifest.title ?? ""} ${manifest.sourceUrl ?? ""}`.trim() || "News story";
  const contentHash = await sha256Hex(articleText || fallbackText);
  const extension = mediaExtensionFromContentType(manifest.assetContentType, "webp");
  const runId = normalizeText(manifest.runId) || crypto.randomUUID();
  const mediaKey = `stories/${storyId}-${contentHash}-${runId}.${extension}`;
  const previousMediaKey = mediaKeyFromPublicUrl(env, existingEntry?.mediaUrl);
  const mediaBytes = new Uint8Array(await assetObject.arrayBuffer());
  await env.MEDIA_BUCKET.put(mediaKey, mediaBytes, {
    httpMetadata: { contentType: manifest.assetContentType ?? "image/webp" }
  });

  const mediaUrl = publicMediaUrlFor(env, mediaKey);
  const updatedAt = now();
  const crawlMetadata = manifest.crawlMetadata && typeof manifest.crawlMetadata === "object"
    ? manifest.crawlMetadata
    : null;
  const headline = crawlMetadata?.headline ?? existingEntry.headline ?? null;
  const summary = crawlMetadata?.summary ?? null;
  const topics = Array.isArray(crawlMetadata?.topics) ? crawlMetadata.topics : null;
  const sourceUrl = normalizeText(manifest.sourceUrl) || null;
  const sourceKind = normalizeText(manifest.sourceKind) || null;

  if (replaceStoredContent) {
    await replaceStoryContent(env, {
      storyId,
      sourceKind: sourceKind ?? "provided",
      extractedText: articleText || null,
      sourceUrl,
      summary,
      explanation: null,
      explanationJson: null,
      aiHeadline: headline,
      topics,
      updatedAt
    });
  } else {
    if (articleText) {
      await storeReadableContent(env, {
        storyId,
        sourceKind: sourceKind ?? "provided",
        extractedText: articleText,
        sourceUrl,
        updatedAt
      });
    }

    if (headline) {
      await storeHeadline(env, storyId, headline);
    }

    if (summary || topics) {
      await storeStorySummary(env, {
        storyId,
        sourceUrl,
        summary,
        topics,
        updatedAt
      });
    }
  }

  await upsertMedia(env, {
    storyId,
    status: "ready",
    falRequestId: `${requestIdPrefix}:${manifest.runId ?? crypto.randomUUID()}`,
    mediaKey,
    mediaUrl,
    failureReason: null,
    attempts: 1,
    updatedAt,
    imagePrompt: manifest.resolvedPrompt ?? null,
    imagePromptGenerationId: manifest.promptGenerationId ?? null,
    optimizerConfigId: manifest.optimizerUsed?.id ?? null,
    mediaType: "image",
    provider: manifest.generationProvider ?? manifest.provider ?? null,
    model: manifest.generationModel ?? manifest.model ?? null,
    generationLatencyMs: Number.isFinite(manifest.latencyMs) ? manifest.latencyMs : null
  });

  await updatePublishedFeedEntry(env, storyId, {
    mediaUrl,
    mediaStatus: "ready",
    headline
  });

  await updatePublishedFeedEntryMediaProjection(env, storyId, {
    mediaType: "image",
    mediaProvider: manifest.generationProvider ?? manifest.provider ?? null,
    mediaModel: manifest.generationModel ?? manifest.model ?? null,
    generationStatus: "ready",
    generationLatencyMs: Number.isFinite(manifest.latencyMs) ? manifest.latencyMs : null,
    generationCostUsd: null
  });

  const updatedEntry = {
    ...existingEntry,
    mediaUrl,
    mediaStatus: "ready",
    headline
  };

  await refreshPublishedFeedSnapshot(env, updatedEntry);

  const shapedResult = await upsertShapedItem(env, {
    storyId,
    headline,
    title: manifest.title ?? "",
    summary,
    category: existingEntry.sourceEndpoint,
    topics,
    publishedAt: existingEntry.publishedAt,
    mediaUrl,
    mediaType: "image",
    mediaProvider: manifest.generationProvider ?? manifest.provider ?? null,
    mediaModel: manifest.generationModel ?? manifest.model ?? null,
    optimizerConfigId: manifest.optimizerUsed?.id ?? null
  });

  if (env.MEDIA_BUCKET?.delete && previousMediaKey && previousMediaKey !== mediaKey) {
    try {
      await env.MEDIA_BUCKET.delete(previousMediaKey);
    } catch (err) {
      log.warn({
        event: "admin_apply_old_media_delete_fail",
        storyId,
        previousMediaKey,
        ...log.fmtError(err)
      });
    }
  }

  return {
    articleText,
    headline,
    summary,
    topics,
    mediaKey,
    mediaUrl,
    shapedResult
  };
}

async function handleAdminTestPrompt(request, env) {
  const authErr = requireAdminKey(request, env);
  if (authErr) return authErr;

  const body = await readJson(request);
  if (!body) return error("Invalid JSON body", 400);

  if (body.applyApprovedTest === true || body.testManifestKey) {
    try {
      return await applyApprovedAdminTest(env, body);
    } catch (err) {
      return error(err instanceof Error ? err.message : "Failed to apply saved test", err?.status ?? 500, err?.details);
    }
  }

  const start = Date.now();

  try {
    const dryRun = adminDryRunEnabled(body);
    const storyId = Number.isInteger(Number(body.storyId)) && Number(body.storyId) > 0
      ? Number(body.storyId)
      : null;
    const existingEntry = storyId
      ? (await getPublishedFeedEntriesByStoryIds(env, [storyId]))[0] ?? null
      : null;
    const resolvedContent = await resolveAdminTestContent(env, body, {
      persistCrawlResult: !dryRun
    });
    const shouldGenerateImage = !dryRun && body.generateImage !== false;
    const optimized = await runAdminPromptOptimization(env, body, resolvedContent, storyId, "admin_test_prompt", {
      persistPromptGeneration: !dryRun
    });

    let optimizerPromptRunEventId = null;
    if (body.logPromptRun !== false && !dryRun) {
      try {
        const eventResult = await createPromptRunEvent(env, {
          source: "admin_test_prompt_optimizer",
          promptKind: "media",
          promptKey: optimized.optimizerConfig.key,
          promptVersion: optimized.optimizerConfig.version,
          optimizerConfigId: optimized.optimizerConfig.id ?? null,
          provider: optimized.optimization.provider ?? optimized.optimizerConfig.optimizerProvider,
          model: optimized.optimization.model ?? optimized.optimizerConfig.optimizerModel,
          modality: "text",
          status: optimized.optimization.status,
          latencyMs: optimized.optimization.latencyMs ?? null,
          requestExcerpt: optimized.optimization.userPrompt?.slice(0, 500) ?? null,
          responseExcerpt: optimized.optimization.optimizedPrompt?.slice(0, 500) ?? null,
          errorText: optimized.optimization.errorText ?? null,
          storyId
        });
        optimizerPromptRunEventId = eventResult?.id ?? null;
      } catch (err) {
        log.warn({ event: "test_prompt_optimizer_log_fail", ...log.fmtError(err) });
      }
    }

    if (!shouldGenerateImage || optimized.optimization.status !== "ready" || !optimized.optimization.optimizedPrompt) {
      return json({
        status: optimized.optimization.status === "ready" ? "resolved" : "failed",
        imageUrl: null,
        r2Url: null,
        provider: null,
        model: null,
        resolvedPrompt: optimized.optimization.optimizedPrompt ?? null,
        optimizerUsed: buildOptimizerUsedPayload(optimized),
        optimizerInput: optimized.optimizerInput,
        imageGenerationSettings: null,
        resolvedContent: {
          title: resolvedContent.title,
          textLength: resolvedContent.articleText.length,
          textPreview: clipAdminPreviewText(resolvedContent.articleText),
          sourceKind: resolvedContent.sourceKind,
          sourceUrl: resolvedContent.sourceUrl,
          metadata: resolvedContent.crawlMetadata,
          crawlProvider: resolvedContent.crawlProvider ?? null,
          cfError: resolvedContent.cfError ?? null,
          cfFailureKind: resolvedContent.cfFailureKind ?? null
        },
        targetStory: existingEntry,
        optimizerLatencyMs: optimized.optimization.latencyMs ?? 0,
        latencyMs: 0,
        totalMs: Date.now() - start,
        error: optimized.optimization.errorText ?? null,
        promptGenerationId: optimized.promptGenerationId,
        optimizerPromptRunEventId,
        imagePromptRunEventId: null,
        billableUnits: null,
        approval: null,
        dryRun
      });
    }

    const resolvedPrompt = optimized.optimization.optimizedPrompt;
    const imageOptions = adminImageGenerationOptions(body, optimized.optimizerConfig);
    const genStart = Date.now();
    const result = await generateImageWithProvider(env, {
      provider: imageOptions.provider,
      model: imageOptions.model,
      settings: imageOptions.settings,
      prompt: resolvedPrompt,
      storyId
    });
    const latencyMs = Date.now() - genStart;

    let approval = null;
    let r2Url = null;
    if (result.status === "ready" && result.url) {
      if (storyId) {
        approval = await writeAdminTestAsset(env, {
          storyId,
          sourceEndpoint: existingEntry?.sourceEndpoint ?? null,
          sourceUrl: resolvedContent.sourceUrl,
          title: resolvedContent.title,
          articleText: resolvedContent.articleText,
          sourceKind: resolvedContent.sourceKind,
          crawlMetadata: resolvedContent.crawlMetadata,
          resolvedPrompt,
          optimizerUsed: buildOptimizerUsedPayload(optimized),
          optimizerInput: optimized.optimizerInput,
          promptGenerationId: optimized.promptGenerationId,
          imageGenerationSettings: imageOptions.settings ?? {},
          provider: result.provider ?? imageOptions.provider,
          model: result.model ?? imageOptions.model,
          generationProvider: result.provider ?? imageOptions.provider,
          generationModel: result.model ?? imageOptions.model,
          latencyMs,
          billableUnits: result.billableUnits ?? null,
          assetUrl: result.url
        });
        r2Url = approval?.assetUrl ?? null;
      } else if (body.uploadToR2 && env.MEDIA_BUCKET?.put) {
        const saved = await writeAdminTestAsset(env, {
          storyId: null,
          sourceEndpoint: null,
          sourceUrl: resolvedContent.sourceUrl,
          title: resolvedContent.title,
          articleText: resolvedContent.articleText,
          sourceKind: resolvedContent.sourceKind,
          crawlMetadata: resolvedContent.crawlMetadata,
          resolvedPrompt,
          optimizerUsed: buildOptimizerUsedPayload(optimized),
          optimizerInput: optimized.optimizerInput,
          promptGenerationId: optimized.promptGenerationId,
          imageGenerationSettings: imageOptions.settings ?? {},
          provider: result.provider ?? imageOptions.provider,
          model: result.model ?? imageOptions.model,
          generationProvider: result.provider ?? imageOptions.provider,
          generationModel: result.model ?? imageOptions.model,
          latencyMs,
          billableUnits: result.billableUnits ?? null,
          assetUrl: result.url
        });
        r2Url = saved?.assetUrl ?? null;
      }
    }

    let imagePromptRunEventId = null;
    if (body.logPromptRun !== false) {
      try {
        const eventResult = await createPromptRunEvent(env, {
          source: "admin_test_prompt",
          promptKind: "media",
          promptKey: optimized.optimizerConfig.key,
          promptVersion: optimized.optimizerConfig.version,
          optimizerConfigId: optimized.optimizerConfig.id ?? null,
          provider: result.provider ?? imageOptions.provider ?? "fal",
          model: result.model ?? imageOptions.model ?? null,
          modality: "image",
          status: result.status === "ready" ? "ready" : "failed",
          latencyMs,
          requestExcerpt: resolvedPrompt.slice(0, 500),
          responseExcerpt: result.url ?? null,
          artifactUrl: approval?.assetUrl ?? result.url ?? null,
          errorText: result.errorText ?? null,
          storyId
        });
        imagePromptRunEventId = eventResult?.id ?? null;
      } catch (err) {
        log.warn({ event: "test_prompt_log_fail", ...log.fmtError(err) });
      }
    }

    return json({
      status: result.status,
      imageUrl: result.url ?? null,
      r2Url,
      provider: result.provider ?? imageOptions.provider,
      model: result.model ?? imageOptions.model,
      resolvedPrompt,
      optimizerUsed: buildOptimizerUsedPayload(optimized),
      optimizerInput: optimized.optimizerInput,
      imageGenerationSettings: imageOptions.settings ?? null,
      resolvedContent: {
        title: resolvedContent.title,
        textLength: resolvedContent.articleText.length,
        textPreview: clipAdminPreviewText(resolvedContent.articleText),
        sourceKind: resolvedContent.sourceKind,
        sourceUrl: resolvedContent.sourceUrl,
        metadata: resolvedContent.crawlMetadata,
        crawlProvider: resolvedContent.crawlProvider ?? null,
        cfError: resolvedContent.cfError ?? null,
        cfFailureKind: resolvedContent.cfFailureKind ?? null
      },
      targetStory: existingEntry,
      optimizerLatencyMs: optimized.optimization.latencyMs ?? 0,
      latencyMs,
      totalMs: Date.now() - start,
      error: result.errorText ?? null,
      promptGenerationId: optimized.promptGenerationId,
      optimizerPromptRunEventId,
      imagePromptRunEventId,
      billableUnits: result.billableUnits ?? null,
      dryRun,
      approval: approval ? {
        canApply: true,
        storyId,
        testManifestKey: approval.manifestKey,
        testAssetKey: approval.assetKey,
        testAssetUrl: approval.assetUrl
      } : null
    });
  } catch (err) {
    return error(err instanceof Error ? err.message : "Admin test failed", err?.status ?? 500, err?.details);
  }
}

// ── Admin Media API (granular endpoints) ────────────────────────────────────

async function handleAdminMediaPrompt(request, env) {
  const authErr = requireAdminKey(request, env);
  if (authErr) return authErr;

  const body = await readJson(request);
  if (!body) return error("Invalid JSON body", 400);

  const start = Date.now();
  try {
    const dryRun = adminDryRunEnabled(body);
    const storyId = Number.isInteger(Number(body.storyId)) && Number(body.storyId) > 0
      ? Number(body.storyId) : null;
    const existingEntry = storyId
      ? (await getPublishedFeedEntriesByStoryIds(env, [storyId]))[0] ?? null : null;
    const resolvedContent = await resolveAdminTestContent(env, body, {
      persistCrawlResult: !dryRun
    });
    const optimized = await runAdminPromptOptimization(env, body, resolvedContent, storyId, "admin_media_prompt", {
      persistPromptGeneration: !dryRun
    });

    let optimizerPromptRunEventId = null;
    if (body.logPromptRun !== false && !dryRun) {
      try {
        const eventResult = await createPromptRunEvent(env, {
          source: "admin_media_prompt_optimizer",
          promptKind: "media",
          promptKey: optimized.optimizerConfig.key,
          promptVersion: optimized.optimizerConfig.version,
          optimizerConfigId: optimized.optimizerConfig.id ?? null,
          provider: optimized.optimization.provider ?? optimized.optimizerConfig.optimizerProvider,
          model: optimized.optimization.model ?? optimized.optimizerConfig.optimizerModel,
          modality: "text",
          status: optimized.optimization.status,
          latencyMs: optimized.optimization.latencyMs ?? null,
          requestExcerpt: optimized.optimization.userPrompt?.slice(0, 500) ?? null,
          responseExcerpt: optimized.optimization.optimizedPrompt?.slice(0, 500) ?? null,
          errorText: optimized.optimization.errorText ?? null,
          storyId
        });
        optimizerPromptRunEventId = eventResult?.id ?? null;
      } catch (err) {
        log.warn({ event: "admin_media_prompt_log_fail", ...log.fmtError(err) });
      }
    }

    return json({
      status: optimized.optimization.status === "ready" ? "resolved" : "failed",
      resolvedPrompt: optimized.optimization.optimizedPrompt ?? null,
      optimizerUsed: buildOptimizerUsedPayload(optimized),
      optimizerInput: optimized.optimizerInput,
      resolvedContent: {
        title: resolvedContent.title,
        textLength: resolvedContent.articleText.length,
        textPreview: clipAdminPreviewText(resolvedContent.articleText),
        sourceKind: resolvedContent.sourceKind,
        sourceUrl: resolvedContent.sourceUrl,
        metadata: resolvedContent.crawlMetadata,
        crawlProvider: resolvedContent.crawlProvider ?? null,
        cfError: resolvedContent.cfError ?? null,
        cfFailureKind: resolvedContent.cfFailureKind ?? null
      },
      targetStory: existingEntry,
      promptGenerationId: optimized.promptGenerationId,
      optimizerPromptRunEventId,
      optimizerLatencyMs: optimized.optimization.latencyMs ?? 0,
      error: optimized.optimization.errorText ?? null,
      dryRun,
      totalMs: Date.now() - start
    });
  } catch (err) {
    return error(err instanceof Error ? err.message : "Admin media prompt failed", err?.status ?? 500, err?.details);
  }
}

async function handleAdminMediaGenerate(request, env) {
  const authErr = requireAdminKey(request, env);
  if (authErr) return authErr;

  const body = await readJson(request);
  if (!body) return error("Invalid JSON body", 400);

  const start = Date.now();
  try {
    const applyToStory = body.applyToStory === true;
    const storyId = Number.isInteger(Number(body.storyId)) && Number(body.storyId) > 0
      ? Number(body.storyId) : null;
    if (applyToStory && !storyId) {
      return error("storyId is required when applyToStory=true", 400);
    }
    const existingEntry = storyId
      ? (await getPublishedFeedEntriesByStoryIds(env, [storyId]))[0] ?? null : null;
    if (applyToStory && !existingEntry) {
      return error("Published feed item not found for storyId", 404);
    }
    const resolvedContent = await resolveAdminTestContent(env, body);
    const optimized = await runAdminPromptOptimization(env, body, resolvedContent, storyId, "admin_media_generate");
    let optimizerPromptRunEventId = null;
    if (body.logPromptRun !== false) {
      try {
        const eventResult = await createPromptRunEvent(env, {
          source: "admin_media_generate_optimizer",
          promptKind: "media",
          promptKey: optimized.optimizerConfig.key,
          promptVersion: optimized.optimizerConfig.version,
          optimizerConfigId: optimized.optimizerConfig.id ?? null,
          provider: optimized.optimization.provider ?? optimized.optimizerConfig.optimizerProvider,
          model: optimized.optimization.model ?? optimized.optimizerConfig.optimizerModel,
          modality: "text",
          status: optimized.optimization.status,
          latencyMs: optimized.optimization.latencyMs ?? null,
          requestExcerpt: optimized.optimization.userPrompt?.slice(0, 500) ?? null,
          responseExcerpt: optimized.optimization.optimizedPrompt?.slice(0, 500) ?? null,
          errorText: optimized.optimization.errorText ?? null,
          storyId
        });
        optimizerPromptRunEventId = eventResult?.id ?? null;
      } catch (err) {
        log.warn({ event: "admin_media_generate_optimizer_log_fail", ...log.fmtError(err) });
      }
    }

    if (optimized.optimization.status !== "ready" || !optimized.optimization.optimizedPrompt) {
      return json({
        status: "failed",
        imageUrl: null,
        previewId: null,
        previewAssetUrl: null,
        provider: null,
        model: null,
        resolvedPrompt: optimized.optimization.optimizedPrompt ?? null,
        optimizerUsed: buildOptimizerUsedPayload(optimized),
        optimizerInput: optimized.optimizerInput,
        imageGenerationSettings: null,
        resolvedContent: {
          title: resolvedContent.title,
          textLength: resolvedContent.articleText.length,
          textPreview: clipAdminPreviewText(resolvedContent.articleText),
          sourceKind: resolvedContent.sourceKind,
          sourceUrl: resolvedContent.sourceUrl,
          metadata: resolvedContent.crawlMetadata,
          crawlProvider: resolvedContent.crawlProvider ?? null,
          cfError: resolvedContent.cfError ?? null,
          cfFailureKind: resolvedContent.cfFailureKind ?? null
        },
        targetStory: existingEntry,
        optimizerLatencyMs: optimized.optimization.latencyMs ?? 0,
        latencyMs: 0,
        totalMs: Date.now() - start,
        error: optimized.optimization.errorText ?? null,
        promptGenerationId: optimized.promptGenerationId,
        optimizerPromptRunEventId,
        imagePromptRunEventId: null,
        billableUnits: null
      });
    }

    const resolvedPrompt = optimized.optimization.optimizedPrompt;
    const imageOptions = adminImageGenerationOptions(body, optimized.optimizerConfig);

    const genStart = Date.now();
    const result = await generateImageWithProvider(env, {
      provider: imageOptions.provider,
      model: imageOptions.model,
      settings: imageOptions.settings,
      prompt: resolvedPrompt,
      storyId
    });
    const latencyMs = Date.now() - genStart;

    let previewId = null;
    let previewAssetUrl = null;
    let appliedResult = null;
    if (result.status === "ready" && result.url) {
      const staged = await writeAdminTestAsset(env, {
        storyId,
        sourceEndpoint: existingEntry?.sourceEndpoint ?? null,
        sourceUrl: resolvedContent.sourceUrl,
        title: resolvedContent.title,
        articleText: resolvedContent.articleText,
        sourceKind: resolvedContent.sourceKind,
        crawlMetadata: resolvedContent.crawlMetadata,
        resolvedPrompt,
        optimizerUsed: buildOptimizerUsedPayload(optimized),
        optimizerInput: optimized.optimizerInput,
        promptGenerationId: optimized.promptGenerationId,
        imageGenerationSettings: imageOptions.settings ?? {},
        provider: result.provider ?? imageOptions.provider,
        model: result.model ?? imageOptions.model,
        generationProvider: result.provider ?? imageOptions.provider,
        generationModel: result.model ?? imageOptions.model,
        latencyMs,
        billableUnits: result.billableUnits ?? null,
        assetUrl: result.url
      });
      previewId = staged?.manifestKey ?? null;
      previewAssetUrl = staged?.assetUrl ?? null;

      if (applyToStory && storyId) {
        if (!existingEntry) {
          return error("Published feed item not found for storyId", 404);
        }
        const manifest = await readAdminTestManifest(env, previewId);
        appliedResult = await applyAdminManifestToStory(env, {
          storyId,
          existingEntry,
          manifest,
          replaceStoredContent: adminReplaceStoryContentEnabled(body),
          requestIdPrefix: "admin_generate_apply"
        });
      }
    }

    let promptRunEventId = null;
    if (body.logPromptRun !== false) {
      try {
        const eventResult = await createPromptRunEvent(env, {
          source: "admin_media_generate",
          promptKind: "media",
          promptKey: optimized.optimizerConfig.key,
          promptVersion: optimized.optimizerConfig.version,
          optimizerConfigId: optimized.optimizerConfig.id ?? null,
          provider: result.provider ?? imageOptions.provider ?? "fal",
          model: result.model ?? imageOptions.model ?? null,
          modality: "image",
          status: result.status === "ready" ? "ready" : "failed",
          latencyMs,
          requestExcerpt: resolvedPrompt.slice(0, 500),
          responseExcerpt: result.url ?? null,
          artifactUrl: previewAssetUrl ?? result.url ?? null,
          errorText: result.errorText ?? null,
          storyId
        });
        promptRunEventId = eventResult?.id ?? null;
      } catch (err) {
        log.warn({ event: "admin_media_generate_log_fail", ...log.fmtError(err) });
      }
    }

    return json({
      status: result.status,
      imageUrl: result.url ?? null,
      previewId,
      previewAssetUrl,
      provider: result.provider ?? imageOptions.provider,
      model: result.model ?? imageOptions.model,
      resolvedPrompt,
      optimizerUsed: buildOptimizerUsedPayload(optimized),
      optimizerInput: optimized.optimizerInput,
      imageGenerationSettings: imageOptions.settings ?? null,
      resolvedContent: {
        title: resolvedContent.title,
        textLength: resolvedContent.articleText.length,
        textPreview: clipAdminPreviewText(resolvedContent.articleText),
        sourceKind: resolvedContent.sourceKind,
        sourceUrl: resolvedContent.sourceUrl,
        metadata: resolvedContent.crawlMetadata,
        crawlProvider: resolvedContent.crawlProvider ?? null,
        cfError: resolvedContent.cfError ?? null,
        cfFailureKind: resolvedContent.cfFailureKind ?? null
      },
      targetStory: existingEntry,
      optimizerLatencyMs: optimized.optimization.latencyMs ?? 0,
      latencyMs,
      totalMs: Date.now() - start,
      error: result.errorText ?? null,
      promptGenerationId: optimized.promptGenerationId,
      optimizerPromptRunEventId,
      imagePromptRunEventId: promptRunEventId,
      billableUnits: result.billableUnits ?? null,
      applied: Boolean(appliedResult),
      replacedStoryContent: Boolean(appliedResult) && adminReplaceStoryContentEnabled(body),
      appliedResult: appliedResult ? {
        storyId,
        mediaKey: appliedResult.mediaKey,
        mediaUrl: appliedResult.mediaUrl,
        headline: appliedResult.headline,
        summary: appliedResult.summary,
        topics: appliedResult.topics
      } : null
    });
  } catch (err) {
    return error(err instanceof Error ? err.message : "Admin media generate failed", err?.status ?? 500, err?.details);
  }
}

async function handleAdminMediaSave(request, env) {
  const authErr = requireAdminKey(request, env);
  if (authErr) return authErr;

  const body = await readJson(request);
  if (!body) return error("Invalid JSON body", 400);

  const previewId = normalizeText(body.previewId);
  if (!previewId) return error("previewId is required", 400);

  try {
    const manifest = await readAdminTestManifest(env, previewId);

    if (!env.MEDIA_BUCKET?.get || !env.MEDIA_BUCKET?.put) {
      return error("MEDIA_BUCKET binding is required", 503);
    }

    const assetObject = await env.MEDIA_BUCKET.get(manifest.assetKey);
    if (!assetObject) return error("Preview asset not found", 404);

    const [maxStoryId, maxSequence] = await Promise.all([
      getMaxStoryId(env),
      getMaxPublishedVisualFeedSequence(env)
    ]);
    const storyId = maxStoryId + 1;
    const publishSequence = maxSequence + 1;
    const category = normalizeText(body.category) || normalizeText(manifest.sourceEndpoint) || "general";
    const updatedAt = now();

    const articleText = typeof manifest.articleText === "string" ? manifest.articleText : "";
    const fallbackText = `${manifest.title ?? ""} ${manifest.sourceUrl ?? ""}`.trim() || "News story";
    const contentHash = await sha256Hex(articleText || fallbackText);
    const extension = mediaExtensionFromContentType(manifest.assetContentType, "webp");
    const mediaKey = `stories/${storyId}-${contentHash}.${extension}`;
    const mediaBytes = new Uint8Array(await assetObject.arrayBuffer());
    await env.MEDIA_BUCKET.put(mediaKey, mediaBytes, {
      httpMetadata: { contentType: manifest.assetContentType ?? "image/webp" }
    });

    const mediaUrl = publicMediaUrlFor(env, mediaKey);
    const crawlMetadata = manifest.crawlMetadata && typeof manifest.crawlMetadata === "object"
      ? manifest.crawlMetadata : null;
    const headline = crawlMetadata?.headline || null;
    const summary = crawlMetadata?.summary ?? null;
    const topics = Array.isArray(crawlMetadata?.topics) ? crawlMetadata.topics : null;
    const sourceUrl = normalizeText(manifest.sourceUrl) || null;
    const sourceKind = normalizeText(manifest.sourceKind) || null;

    await storeStory(env, storyId, category, 0);

    if (articleText) {
      await storeReadableContent(env, {
        storyId,
        sourceKind: sourceKind ?? "provided",
        extractedText: articleText,
        sourceUrl,
        updatedAt
      });
    }

    if (headline) {
      await storeHeadline(env, storyId, headline);
    }

    if (summary || topics) {
      await storeStorySummary(env, {
        storyId,
        sourceUrl,
        summary,
        topics,
        updatedAt
      });
    }

    await upsertMedia(env, {
      storyId,
      status: "ready",
      falRequestId: `admin_save:${manifest.runId ?? crypto.randomUUID()}`,
      mediaKey,
      mediaUrl,
      failureReason: null,
      attempts: 1,
      updatedAt,
      imagePrompt: manifest.resolvedPrompt ?? null,
      imagePromptGenerationId: manifest.promptGenerationId ?? null,
      optimizerConfigId: manifest.optimizerUsed?.id ?? null,
      mediaType: "image",
      provider: manifest.generationProvider ?? manifest.provider ?? null,
      model: manifest.generationModel ?? manifest.model ?? null,
      generationLatencyMs: Number.isFinite(manifest.latencyMs) ? manifest.latencyMs : null
    });

    await publishReadyStory(env, {
      storyId,
      publishSequence,
      sourceEndpoint: category,
      publishedAt: updatedAt,
      mediaUrl,
      mediaStatus: "ready",
      headline
    });

    const publishedEntry = {
      storyId,
      publishSequence,
      sourceEndpoint: category,
      publishedAt: updatedAt,
      mediaUrl,
      mediaStatus: "ready",
      headline
    };

    await refreshPublishedFeedSnapshot(env, publishedEntry);

    await upsertShapedItem(env, {
      storyId,
      headline,
      title: manifest.title ?? "",
      summary,
      category,
      topics,
      publishedAt: updatedAt,
      mediaUrl,
      mediaType: "image",
      mediaProvider: manifest.generationProvider ?? manifest.provider ?? null,
      mediaModel: manifest.generationModel ?? manifest.model ?? null,
      optimizerConfigId: manifest.optimizerUsed?.id ?? null
    });

    return json({
      ok: true,
      storyId,
      saved: true,
      previewId,
      mediaKey,
      mediaUrl,
      publishedEntry,
      contentUpdated: {
        readableContent: Boolean(articleText),
        headline: Boolean(headline),
        summary: Boolean(summary),
        topics: Array.isArray(topics) ? topics.length : 0
      }
    });
  } catch (err) {
    return error(err instanceof Error ? err.message : "Admin media save failed", err?.status ?? 500, err?.details);
  }
}

async function handleAdminMediaApply(request, env, pathStoryId) {
  const authErr = requireAdminKey(request, env);
  if (authErr) return authErr;

  const body = await readJson(request);
  if (!body) return error("Invalid JSON body", 400);

  const previewId = normalizeText(body.previewId);
  if (!previewId) return error("previewId is required", 400);

  const storyId = Number(pathStoryId);
  if (!Number.isInteger(storyId) || storyId <= 0) {
    return error("Invalid storyId in path", 400);
  }

  try {
    const manifest = await readAdminTestManifest(env, previewId);

    if (manifest.storyId != null && Number(manifest.storyId) !== storyId) {
      return error("storyId does not match the preview manifest", 409);
    }

    const existingEntry = (await getPublishedFeedEntriesByStoryIds(env, [storyId]))[0] ?? null;
    if (!existingEntry) {
      return error("Published feed item not found for storyId", 404);
    }

    if (!env.MEDIA_BUCKET?.get || !env.MEDIA_BUCKET?.put) {
      return error("MEDIA_BUCKET binding is required", 503);
    }
    const applied = await applyAdminManifestToStory(env, {
      storyId,
      existingEntry,
      manifest,
      replaceStoredContent: adminReplaceStoryContentEnabled(body),
      requestIdPrefix: "admin_apply"
    });

    return json({
      ok: true,
      storyId,
      applied: true,
      previewId,
      mediaKey: applied.mediaKey,
      mediaUrl: applied.mediaUrl,
      publishedEntry: {
        storyId,
        publishSequence: existingEntry.publishSequence,
        publishedAt: existingEntry.publishedAt,
        sourceEndpoint: existingEntry.sourceEndpoint,
        mediaStatus: "ready",
        headline: applied.headline
      },
      contentUpdated: {
        readableContent: Boolean(applied.articleText),
        headline: Boolean(applied.headline),
        summary: Boolean(applied.summary),
        topics: Array.isArray(applied.topics) ? applied.topics.length : 0
      },
      replacedStoryContent: adminReplaceStoryContentEnabled(body),
      shaped: applied.shapedResult
    });
  } catch (err) {
    return error(err instanceof Error ? err.message : "Admin media apply failed", err?.status ?? 500, err?.details);
  }
}

const ROUTES = [
  { method: "GET",   path: "/health",               name: "health",           handler: (r, e) => json({ ok: true, service: e.APP_NAME ?? "NewsRoll Backend", environment: e.ENVIRONMENT ?? "unknown" }) },
  { method: "GET",   path: "/v1/config",             name: "config",           handler: handleConfig },
  { method: "GET",   path: "/v1/visual-feed",        name: "visual_feed",      handler: handleVisualFeed },
  { method: "POST",  path: "/v1/events",             name: "events",          handler: handleEvents },
  { method: "POST",  path: "/landing/lead",           name: "landing_lead",    handler: handleLandingLead },
  { method: "POST",  path: "/v1/ai/summary",          name: "ai_summary",      handler: handleAISummary },
  { method: "POST",  path: "/v1/ai/translate",         name: "ai_translate",    handler: handleAITranslate },
  { method: "POST",  path: "/v1/ai/explain",           name: "ai_explain",      handler: handleAIExplain },
  { method: "GET",   path: "/v1/credits",              name: "credits",         handler: handleGetCredits },
  { method: "POST",  path: "/admin/test-prompt",       name: "admin_test_prompt", handler: handleAdminTestPrompt },
  { method: "POST",  path: "/admin/media/prompt",      name: "admin_media_prompt",   handler: handleAdminMediaPrompt },
  { method: "POST",  path: "/admin/media/generate",    name: "admin_media_generate", handler: handleAdminMediaGenerate },
  { method: "POST",  path: "/admin/media/save",        name: "admin_media_save",     handler: handleAdminMediaSave },
  { method: "POST",  path: "/admin/media/crawl",       name: "admin_media_crawl",    handler: handleAdminMediaCrawl },
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

  // GET /admin/stories/:storyId
  if (request.method === "GET" && segments[0] === "admin" && segments[1] === "stories" && segments[2]) {
    const authErr = requireAdminKey(request, env);
    if (authErr) return { response: authErr, route: "admin_story_current_data" };
    const response = await handleAdminStoryCurrentData(env, segments[2]);
    return { response, route: "admin_story_current_data" };
  }

  // GET /admin/media/crawl/:taskId
  if (request.method === "GET" && segments[0] === "admin" && segments[1] === "media" && segments[2] === "crawl" && segments[3]) {
    const authErr = requireAdminKey(request, env);
    if (authErr) return { response: authErr, route: "admin_media_crawl_status" };
    const response = await handleAdminMediaCrawlStatus(env, segments[3]);
    return { response, route: "admin_media_crawl_status" };
  }

  // PUT /admin/media/:storyId
  if (request.method === "PUT" && segments[0] === "admin" && segments[1] === "media" && segments[2]) {
    const response = await handleAdminMediaApply(request, env, segments[2]);
    return { response, route: "admin_media_apply" };
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
      return withRequestId(withCors(response, request), rid);
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
        return withRequestId(withCors(thrown, request), rid);
      }
      log.error({
        event: "request_error",
        rid,
        ...meta,
        durationMs,
        ...log.fmtError(thrown),
      });
      return withRequestId(withCors(error(thrown instanceof Error ? thrown.message : "Unexpected error", 500), request), rid);
    }
  }
};
