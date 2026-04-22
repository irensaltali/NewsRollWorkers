import { createClient } from "@supabase/supabase-js";
import { fixtureFeed } from "./fixtures.mjs";
import { normalizePersistedCostFields, serializeCostFields } from "./model-catalog.mjs";
import { AI_PROMPT_KEYS, DEFAULT_AI_PROMPT_CONFIGS, parsePromptSettings } from "./prompt-config.mjs";
import {
  DEFAULT_IMAGE_PROMPT_OPTIMIZER_CONFIG,
  DEFAULT_IMAGE_PROMPT_OPTIMIZER_KEY,
  DEFAULT_IMAGE_PROMPT_OPTIMIZER_VERSION,
  imagePromptOptimizerConfigWithFallback,
  selectImagePromptOptimizerConfig
} from "./image-prompt-optimizer.mjs";
import {
  queryStoryStats
} from "./event-analytics.mjs";
import * as log from "./log.mjs";

export function getSupabaseSecretKey(env) {
  return env?.SUPABASE_SECRET_KEY ?? env?.SUPABASE_SERVICE_ROLE_KEY ?? null;
}

function getDB(env) {
  return createClient(env.SUPABASE_URL, getSupabaseSecretKey(env), {
    auth: { persistSession: false }
  });
}

export function hasDB(env) {
  return Boolean(env?.SUPABASE_URL && getSupabaseSecretKey(env));
}

function getLegacyTestDB(env) {
  return env?.DB && typeof env.DB.prepare === "function" ? env.DB : null;
}

// snake_case → camelCase for a single row object
function toCamel(str) {
  return str.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function row(data) {
  if (!data) return null;
  return Object.fromEntries(Object.entries(data).map(([k, v]) => [toCamel(k), v]));
}

function rows(data) {
  return (data ?? []).map(row);
}

function normalizeNullableText(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function assignDefined(target, key, value) {
  if (value !== undefined && value !== null) {
    target[key] = value;
  }
}

export function isRSSSourceDueForFetch(source, now = Date.now()) {
  const lastFetchedAt = source?.lastFetchedAt ?? source?.last_fetched_at ?? null;
  const rawInterval = source?.fetchIntervalMinutes ?? source?.fetch_interval_minutes ?? null;
  const intervalMinutes = Number.parseInt(`${rawInterval ?? ""}`, 10);

  if (!lastFetchedAt) {
    return true;
  }

  const lastFetchedMs = Date.parse(lastFetchedAt);
  if (!Number.isFinite(lastFetchedMs)) {
    return true;
  }

  if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
    return true;
  }

  return now - lastFetchedMs >= intervalMinutes * 60_000;
}

function fixturePublishedFeed(cursor = null, limit = 20) {
  return fixtureFeed
    .slice()
    .sort((a, b) => b.publishSequence - a.publishSequence)
    .filter((item) => cursor == null || item.publishSequence < cursor)
    .slice(0, limit);
}

async function listStorySourceUrls(env, storyIds) {
  if (!hasDB(env) || !Array.isArray(storyIds) || storyIds.length === 0) {
    return new Map();
  }

  const uniqueStoryIds = [...new Set(storyIds.filter((storyId) => Number.isFinite(Number(storyId))))];
  if (uniqueStoryIds.length === 0) {
    return new Map();
  }

  const { data } = await getDB(env)
    .from("story_content")
    .select("story_id, source_url")
    .in("story_id", uniqueStoryIds);

  return new Map(
    (data ?? [])
      .filter((entry) => entry?.source_url)
      .map((entry) => [Number(entry.story_id), entry.source_url])
  );
}

async function listStoryMediaUrls(env, storyIds) {
  if (!hasDB(env) || !Array.isArray(storyIds) || storyIds.length === 0) {
    return new Map();
  }

  const uniqueStoryIds = [...new Set(storyIds.filter((storyId) => Number.isFinite(Number(storyId))))];
  if (uniqueStoryIds.length === 0) {
    return new Map();
  }

  const { data } = await getDB(env)
    .from("story_media")
    .select("story_id, media_url")
    .in("story_id", uniqueStoryIds);

  return new Map(
    (data ?? [])
      .filter((entry) => entry?.media_url)
      .map((entry) => [Number(entry.story_id), entry.media_url])
  );
}

// ── Visual feed ──────────────────────────────────────────────────────────────

export async function listPublishedVisualFeed(env, { cursor = null, limit = 20 } = {}) {
  if (!hasDB(env)) return fixturePublishedFeed(cursor, limit);

  let data = null;
  try {
    const result = await getDB(env).rpc("get_visual_feed", {
      p_cursor: cursor ?? null,
      p_limit: limit
    });
    data = result.data ?? null;
  } catch {
    const query = getDB(env)
      .from("published_feed_entries")
      .select("story_id, publish_sequence, source_endpoint, published_at, media_url, media_status, headline")
      .order("publish_sequence", { ascending: false })
      .limit(limit);

    const { data: rows } = cursor == null
      ? await query
      : await query.lt("publish_sequence", cursor);
    data = rows ?? [];
  }

  const sourceUrlsByStoryId = await listStorySourceUrls(
    env,
    (data ?? []).map((entry) => Number(entry.story_id))
  );
  const mediaUrlsByStoryId = await listStoryMediaUrls(
    env,
    (data ?? []).map((entry) => Number(entry.story_id))
  );

  return (data ?? []).map((r) => ({
    storyId: r.story_id,
    publishSequence: r.publish_sequence,
    sourceEndpoint: r.source_endpoint,
    publishedAt: r.published_at,
    mediaUrl: mediaUrlsByStoryId.get(Number(r.story_id)) ?? r.media_url ?? null,
    sourceUrl: sourceUrlsByStoryId.get(Number(r.story_id)) ?? null,
    mediaStatus: r.media_status,
    headline: r.headline
  }));
}

export async function getPublishedFeedEntriesByStoryIds(env, storyIds) {
  if (!hasDB(env) || !Array.isArray(storyIds) || storyIds.length === 0) {
    return [];
  }

  const uniqueIds = [...new Set(storyIds.map(Number).filter(Number.isFinite))];
  if (uniqueIds.length === 0) return [];

  const { data } = await getDB(env)
    .from("published_feed_entries")
    .select("story_id, publish_sequence, source_endpoint, published_at, media_url, media_status, headline")
    .in("story_id", uniqueIds);

  const sourceUrlsByStoryId = await listStorySourceUrls(env, uniqueIds);
  const mediaUrlsByStoryId = await listStoryMediaUrls(env, uniqueIds);

  const rowsByStoryId = new Map(
    (data ?? []).map((r) => [Number(r.story_id), {
      storyId: Number(r.story_id),
      publishSequence: r.publish_sequence,
      sourceEndpoint: r.source_endpoint,
      publishedAt: r.published_at,
      mediaUrl: mediaUrlsByStoryId.get(Number(r.story_id)) ?? r.media_url ?? null,
      sourceUrl: sourceUrlsByStoryId.get(Number(r.story_id)) ?? null,
      mediaStatus: r.media_status,
      headline: r.headline
    }])
  );

  // Preserve the original storyIds order (Shaped ranking order)
  return storyIds.map((id) => rowsByStoryId.get(Number(id))).filter(Boolean);
}

export async function updatePublishedFeedEntry(env, storyId, fields) {
  if (!hasDB(env)) return false;

  const updates = {};
  assignDefined(updates, "source_endpoint", fields.sourceEndpoint);
  assignDefined(updates, "published_at", fields.publishedAt);
  assignDefined(updates, "media_url", fields.mediaUrl);
  assignDefined(updates, "media_status", fields.mediaStatus);
  assignDefined(updates, "headline", fields.headline);

  if (Object.keys(updates).length === 0) {
    return true;
  }

  const { error } = await getDB(env)
    .from("published_feed_entries")
    .update(updates)
    .eq("story_id", storyId);

  return !error;
}

export async function getLatestPublishedVisualFeedSnapshot(env, limit = 100) {
  return listPublishedVisualFeed(env, { limit });
}

export async function getMaxPublishedVisualFeedSequence(env) {
  if (!hasDB(env)) {
    return fixtureFeed.reduce((max, item) => Math.max(max, item.publishSequence ?? 0), 0);
  }

  const { data } = await getDB(env)
    .from("published_feed_entries")
    .select("publish_sequence")
    .order("publish_sequence", { ascending: false })
    .limit(1)
    .single();

  return Number(data?.publish_sequence ?? 0);
}

export async function getMaxStoryId(env) {
  if (!hasDB(env)) return 0;

  const { data } = await getDB(env)
    .from("feed_entries")
    .select("story_id")
    .order("story_id", { ascending: false })
    .limit(1)
    .single();

  return Number(data?.story_id ?? 0);
}

export async function isStoryPublished(env, storyId) {
  if (!hasDB(env)) return fixtureFeed.some((item) => item.storyId === storyId);

  const { data } = await getDB(env)
    .from("published_feed_entries")
    .select("story_id")
    .eq("story_id", storyId)
    .maybeSingle();

  return Boolean(data);
}

export async function publishReadyStory(env, payload) {
  if (!hasDB(env)) return !fixtureFeed.some((item) => item.storyId === payload.storyId);

  const { error } = await getDB(env)
    .from("published_feed_entries")
    .insert({
      story_id: payload.storyId,
      publish_sequence: payload.publishSequence,
      source_endpoint: payload.sourceEndpoint,
      published_at: payload.publishedAt,
      media_status: payload.mediaStatus ?? null,
      headline: payload.headline ?? null
    });

  // Postgres UNIQUE constraint on story_id → duplicate means already published
  return !error;
}

// ── Feed entries (ingest staging) ────────────────────────────────────────────

export async function storeStory(env, storyId, endpoint, rank) {
  if (!hasDB(env)) return;

  await getDB(env)
    .from("feed_entries")
    .upsert({ endpoint, story_id: storyId, rank, snapshot_at: new Date().toISOString() });
}

// ── Story content ─────────────────────────────────────────────────────────────

async function resolveStoryContentUrls(env, storyId, { sourceUrl = null, feedUrl = null } = {}) {
  let resolvedSourceUrl = normalizeNullableText(sourceUrl);
  let resolvedFeedUrl = normalizeNullableText(feedUrl);

  if ((!resolvedSourceUrl || !resolvedFeedUrl) && Number.isInteger(Number(storyId)) && Number(storyId) > 0) {
    const rssItem = await getStoryContentMetadataByStoryId(env, storyId);
    if (!resolvedSourceUrl) {
      resolvedSourceUrl = normalizeNullableText(rssItem?.canonicalUrl ?? rssItem?.url ?? null);
    }
    if (!resolvedFeedUrl) {
      resolvedFeedUrl = normalizeNullableText(rssItem?.feedUrl ?? null);
    }
  }

  return {
    sourceUrl: resolvedSourceUrl,
    feedUrl: resolvedFeedUrl
  };
}

async function upsertStoryContent(env, payload) {
  if (!hasDB(env)) return;

  const resolvedUrls = await resolveStoryContentUrls(env, payload.storyId, {
    sourceUrl: payload.sourceUrl ?? null,
    feedUrl: payload.feedUrl ?? null
  });

  const row = {
    story_id: payload.storyId,
    updated_at: payload.updatedAt
  };

  assignDefined(row, "source_kind", payload.sourceKind);
  assignDefined(row, "extracted_text", payload.extractedText);
  assignDefined(row, "source_url", resolvedUrls.sourceUrl);
  assignDefined(row, "feed_url", resolvedUrls.feedUrl);
  assignDefined(row, "summary", payload.summary);
  assignDefined(row, "explanation", payload.explanation);
  assignDefined(row, "explanation_json", payload.explanationJson);
  assignDefined(row, "ai_headline", payload.aiHeadline);
  assignDefined(row, "topics", payload.topics);

  await getDB(env)
    .from("story_content")
    .upsert(row);
}

export async function storeReadableContent(env, payload) {
  await upsertStoryContent(env, payload);
}

export async function replaceStoryContent(env, payload) {
  if (!hasDB(env)) return;

  const resolvedUrls = await resolveStoryContentUrls(env, payload.storyId, {
    sourceUrl: payload.sourceUrl ?? null,
    feedUrl: payload.feedUrl ?? null
  });

  await getDB(env)
    .from("story_content")
    .upsert({
      story_id: payload.storyId,
      source_kind: payload.sourceKind ?? "unknown",
      extracted_text: payload.extractedText ?? null,
      source_url: resolvedUrls.sourceUrl,
      feed_url: resolvedUrls.feedUrl,
      summary: payload.summary ?? null,
      explanation: payload.explanation ?? null,
      explanation_json: payload.explanationJson ?? null,
      ai_headline: payload.aiHeadline ?? null,
      topics: payload.topics ?? null,
      updated_at: payload.updatedAt
    });
}

export async function getReadableContent(env, storyId) {
  if (!hasDB(env)) return null;

  const { data } = await getDB(env)
    .from("story_content")
    .select("extracted_text, ai_headline")
    .eq("story_id", storyId)
    .maybeSingle();

  return data ? { extractedText: data.extracted_text, aiHeadline: data.ai_headline ?? null } : null;
}

export async function getStorySummaryAndContent(env, storyId) {
  if (!hasDB(env)) return null;

  const { data } = await getDB(env)
    .from("story_content")
    .select("summary, extracted_text, ai_headline, topics")
    .eq("story_id", storyId)
    .maybeSingle();

  if (!data) return null;
  return {
    summary: data.summary ?? null,
    extractedText: data.extracted_text ?? null,
    aiHeadline: data.ai_headline ?? null,
    topics: Array.isArray(data.topics) ? data.topics : null
  };
}

export async function getAdminStoryCurrentData(env, storyId) {
  if (!hasDB(env)) return null;

  const numericStoryId = Number(storyId);
  if (!Number.isInteger(numericStoryId) || numericStoryId <= 0) {
    return null;
  }

  const [publishedResult, contentResult, mediaResult, sourceMetadata] = await Promise.all([
    getDB(env)
      .from("published_feed_entries")
      .select("story_id, publish_sequence, source_endpoint, published_at, media_url, media_status, headline, media_type, media_provider, media_model, generation_status, generation_latency_ms, generation_cost_usd, engagement_count, impression_count")
      .eq("story_id", numericStoryId)
      .maybeSingle(),
    getDB(env)
      .from("story_content")
      .select("story_id, source_kind, extracted_text, ai_headline, source_url, feed_url, summary, explanation, explanation_json, topics, updated_at")
      .eq("story_id", numericStoryId)
      .maybeSingle(),
    getDB(env)
      .from("story_media")
      .select("story_id, status, fal_request_id, media_key, media_url, failure_reason, attempts, image_prompt, image_prompt_generation_id, optimizer_config_id, media_type, provider, model, generation_latency_ms, updated_at")
      .eq("story_id", numericStoryId)
      .maybeSingle(),
    getStoryContentMetadataByStoryId(env, numericStoryId)
  ]);

  const published = publishedResult.data
    ? {
      storyId: Number(publishedResult.data.story_id),
      publishSequence: publishedResult.data.publish_sequence ?? null,
      sourceEndpoint: publishedResult.data.source_endpoint ?? null,
      publishedAt: publishedResult.data.published_at ?? null,
      mediaStatus: publishedResult.data.media_status ?? null,
      headline: publishedResult.data.headline ?? null,
      mediaType: publishedResult.data.media_type ?? null,
      mediaProvider: publishedResult.data.media_provider ?? null,
      mediaModel: publishedResult.data.media_model ?? null,
      generationStatus: publishedResult.data.generation_status ?? null,
      generationLatencyMs: publishedResult.data.generation_latency_ms ?? null,
      generationCostUsd: publishedResult.data.generation_cost_usd ?? null,
      engagementCount: publishedResult.data.engagement_count ?? null,
      impressionCount: publishedResult.data.impression_count ?? null
    }
    : null;

  const content = contentResult.data
    ? {
      storyId: Number(contentResult.data.story_id),
      sourceKind: contentResult.data.source_kind ?? null,
      extractedText: contentResult.data.extracted_text ?? null,
      aiHeadline: contentResult.data.ai_headline ?? null,
      sourceUrl: contentResult.data.source_url ?? null,
      feedUrl: contentResult.data.feed_url ?? null,
      summary: contentResult.data.summary ?? null,
      explanation: contentResult.data.explanation ?? null,
      explanationJson: contentResult.data.explanation_json ?? null,
      topics: Array.isArray(contentResult.data.topics) ? contentResult.data.topics : null,
      updatedAt: contentResult.data.updated_at ?? null
    }
    : null;

  const media = mediaResult.data
    ? {
      storyId: Number(mediaResult.data.story_id),
      status: mediaResult.data.status ?? null,
      falRequestId: mediaResult.data.fal_request_id ?? null,
      mediaKey: mediaResult.data.media_key ?? null,
      mediaUrl: mediaResult.data.media_url ?? null,
      failureReason: mediaResult.data.failure_reason ?? null,
      attempts: mediaResult.data.attempts ?? null,
      imagePrompt: mediaResult.data.image_prompt ?? null,
      imagePromptGenerationId: mediaResult.data.image_prompt_generation_id ?? null,
      optimizerConfigId: mediaResult.data.optimizer_config_id ?? null,
      mediaType: mediaResult.data.media_type ?? null,
      provider: mediaResult.data.provider ?? null,
      model: mediaResult.data.model ?? null,
      generationLatencyMs: mediaResult.data.generation_latency_ms ?? null,
      updatedAt: mediaResult.data.updated_at ?? null
    }
    : null;

  if (!published && !content && !media && !sourceMetadata) {
    return null;
  }

  return {
    storyId: numericStoryId,
    publishedEntry: published,
    storyContent: content,
    storyMedia: media,
    sourceMetadata: sourceMetadata
      ? {
        url: sourceMetadata.url ?? null,
        canonicalUrl: sourceMetadata.canonicalUrl ?? null,
        feedUrl: sourceMetadata.feedUrl ?? null
      }
      : null
  };
}

export async function getStoryExplanationData(env, storyId) {
  if (!hasDB(env)) return null;

  const { data } = await getDB(env)
    .from("story_content")
    .select("explanation_json")
    .eq("story_id", storyId)
    .maybeSingle();

  return data?.explanation_json ?? null;
}

export async function storeStoryExplanationData(env, storyId, explanationData) {
  await upsertStoryContent(env, {
    storyId,
    explanationJson: explanationData,
    updatedAt: new Date().toISOString()
  });
}

export async function storeHeadline(env, storyId, headline) {
  await upsertStoryContent(env, {
    storyId,
    aiHeadline: headline,
    updatedAt: new Date().toISOString()
  });
}

export async function storeStorySummary(env, payload) {
  await upsertStoryContent(env, {
    storyId: payload.storyId,
    sourceUrl: payload.sourceUrl ?? null,
    feedUrl: payload.feedUrl ?? null,
    summary: payload.summary,
    topics: payload.topics ?? null,
    updatedAt: payload.updatedAt
  });
}

export async function storeStoryExplanation(env, payload) {
  await upsertStoryContent(env, {
    storyId: payload.storyId,
    sourceUrl: payload.sourceUrl ?? null,
    feedUrl: payload.feedUrl ?? null,
    explanation: payload.explanation,
    updatedAt: payload.updatedAt
  });
}

// ── Story media ───────────────────────────────────────────────────────────────

export async function upsertMedia(env, payload) {
  if (!hasDB(env)) return;

  await getDB(env)
    .from("story_media")
    .upsert({
      story_id: payload.storyId,
      status: payload.status,
      fal_request_id: payload.falRequestId ?? null,
      media_key: payload.mediaKey ?? null,
      media_url: payload.mediaUrl ?? null,
      failure_reason: payload.failureReason ?? null,
      attempts: payload.attempts ?? 0,
      updated_at: payload.updatedAt,
      image_prompt: payload.imagePrompt ?? null,
      image_prompt_generation_id: payload.imagePromptGenerationId ?? null,
      optimizer_config_id: payload.optimizerConfigId ?? null,
      media_type: payload.mediaType ?? null,
      provider: payload.provider ?? null,
      model: payload.model ?? null,
      generation_latency_ms: payload.generationLatencyMs ?? null
    });
}

export async function reserveMediaQueueSlot(env, payload) {
  if (!hasDB(env)) return true;

  const { data } = await getDB(env).rpc("reserve_media_slot", {
    p_story_id: payload.storyId,
    p_daily_limit: payload.dailyLimit ?? 500
  });

  return Boolean(data);
}

export async function releaseMediaQueueSlot(env, storyId) {
  if (!hasDB(env)) return;

  await getDB(env)
    .from("story_media")
    .delete()
    .eq("story_id", storyId)
    .eq("status", "queued")
    .eq("attempts", 0);
}

// ── Crawl state tracking on story_media ──────────────────────────────────────

export async function selectCrawlState(env, storyId) {
  if (!hasDB(env)) return null;

  const { data } = await getDB(env)
    .from("story_media")
    .select("story_id, status, crawl_provider, crawl_job_id, crawl_submitted_at, crawl_poll_count, crawl_deadline, crawl_errors")
    .eq("story_id", storyId)
    .maybeSingle();

  if (!data) return null;
  return {
    storyId: data.story_id,
    status: data.status,
    crawlProvider: data.crawl_provider,
    crawlJobId: data.crawl_job_id,
    crawlSubmittedAt: data.crawl_submitted_at,
    crawlPollCount: data.crawl_poll_count ?? 0,
    crawlDeadline: data.crawl_deadline,
    crawlErrors: Array.isArray(data.crawl_errors) ? data.crawl_errors : []
  };
}

export async function upsertCrawlState(env, { storyId, provider, jobId, submittedAt, deadline }) {
  if (!hasDB(env)) return;

  await getDB(env)
    .from("story_media")
    .upsert({
      story_id: storyId,
      status: "queued",
      attempts: 0,
      crawl_provider: provider,
      crawl_job_id: jobId,
      crawl_submitted_at: submittedAt,
      crawl_poll_count: 0,
      crawl_deadline: deadline,
      updated_at: new Date().toISOString()
    });
}

export async function incrementCrawlPollCount(env, storyId) {
  if (!hasDB(env)) return 0;

  const { data } = await getDB(env).rpc("increment_crawl_poll_count", {
    p_story_id: storyId
  });
  return Number(data ?? 0);
}

export async function appendCrawlError(env, storyId, { provider, error }) {
  if (!hasDB(env)) return;

  await getDB(env).rpc("append_crawl_error", {
    p_story_id: storyId,
    p_entry: { provider, error, at: new Date().toISOString() }
  });
}

export async function clearCrawlState(env, storyId) {
  if (!hasDB(env)) return;

  await getDB(env)
    .from("story_media")
    .update({
      crawl_provider: null,
      crawl_job_id: null,
      crawl_submitted_at: null,
      crawl_poll_count: 0,
      crawl_deadline: null,
      updated_at: new Date().toISOString()
    })
    .eq("story_id", storyId);
}

export async function cleanupStaleMedia(env, days = 7) {
  if (!hasDB(env)) return 0;

  const { data } = await getDB(env).rpc("cleanup_stale_media", { p_days: days });
  return Number(data ?? 0);
}

// ── Event-derived state ───────────────────────────────────────────────────────

export async function upsertUserSessionsFromEvents(env, userId, events) {
  if (!hasDB(env) || events.length === 0) return 0;

  const aggregates = new Map();
  for (const event of events) {
    if (!event.sessionId) continue;
    const current = aggregates.get(event.sessionId) ?? {
      sessionId: event.sessionId,
      surface: event.surface ?? "unknown",
      cardsViewed: 0,
      detailOpens: 0,
      externalOpens: 0,
      shares: 0,
      saves: 0,
      hides: 0,
      aiActions: 0
    };

    if (event.eventType === "impression") current.cardsViewed += 1;
    if (event.eventType === "detail_open") current.detailOpens += 1;
    if (event.eventType === "external_open") current.externalOpens += 1;
    if (event.eventType === "share") current.shares += 1;
    if (event.eventType === "save") current.saves += 1;
    if (event.eventType === "hide") current.hides += 1;
    if (event.eventType.startsWith("ai_")) current.aiActions += 1;

    aggregates.set(event.sessionId, current);
  }

  const sessionIds = [...aggregates.keys()];
  if (sessionIds.length === 0) return 0;

  const { data: existingRows } = await getDB(env)
    .from("user_sessions")
    .select("session_id, user_id, surface, started_at, cards_viewed, detail_opens, external_opens, shares, saves, hides, ai_actions")
    .in("session_id", sessionIds);

  const existingById = new Map((existingRows ?? []).map((row) => [row.session_id, row]));
  const updatedAt = new Date().toISOString();
  const rows = sessionIds.map((sessionId) => {
    const aggregate = aggregates.get(sessionId);
    const existing = existingById.get(sessionId);
    const row = {
      session_id: sessionId,
      user_id: existing?.user_id ?? userId,
      surface: existing?.surface ?? aggregate.surface,
      ended_at: updatedAt,
      cards_viewed: Number(existing?.cards_viewed ?? 0) + aggregate.cardsViewed,
      detail_opens: Number(existing?.detail_opens ?? 0) + aggregate.detailOpens,
      external_opens: Number(existing?.external_opens ?? 0) + aggregate.externalOpens,
      shares: Number(existing?.shares ?? 0) + aggregate.shares,
      saves: Number(existing?.saves ?? 0) + aggregate.saves,
      hides: Number(existing?.hides ?? 0) + aggregate.hides,
      ai_actions: Number(existing?.ai_actions ?? 0) + aggregate.aiActions
    };
    if (existing?.started_at) {
      row.started_at = existing.started_at;
    }
    return row;
  });

  await getDB(env)
    .from("user_sessions")
    .upsert(rows, { onConflict: "session_id" });

  return rows.length;
}

export async function attachStoryContextToEvents(env, events) {
  if (!hasDB(env) || !events?.length) {
    return events;
  }

  const storyIds = [...new Set(events.map((event) => event.storyId).filter(Number.isInteger))];
  if (storyIds.length === 0) {
    return events;
  }

  const [{ data: feedData }, { data: contentData }, { data: mediaData }] = await Promise.all([
    getDB(env).from("published_feed_entries").select("story_id, source_endpoint, media_type").in("story_id", storyIds),
    getDB(env).from("story_content").select("story_id, topics").in("story_id", storyIds),
    getDB(env).from("story_media").select("story_id, media_type").in("story_id", storyIds)
  ]);

  const byStoryId = new Map((feedData ?? []).map((row) => [row.story_id, row]));
  const contentByStoryId = new Map((contentData ?? []).map((row) => [row.story_id, row]));
  const mediaByStoryId = new Map((mediaData ?? []).map((row) => [row.story_id, row]));

  return events.map((event) => {
    const story = byStoryId.get(event.storyId);
    const content = contentByStoryId.get(event.storyId);
    const media = mediaByStoryId.get(event.storyId);
    return {
      ...event,
      sourceEndpoint: event.sourceEndpoint ?? story?.source_endpoint ?? null,
      mediaType: event.mediaType ?? story?.media_type ?? media?.media_type ?? null,
      topics: Array.isArray(content?.topics) && content.topics.length > 0 ? content.topics : null
    };
  });
}

// ── AI results cache ──────────────────────────────────────────────────────────

export async function getCachedAIResult(env, cacheKey) {
  if (!hasDB(env)) return null;

  const { data } = await getDB(env)
    .from("ai_results_cache")
    .select("result_text, result_type, model, created_at")
    .eq("cache_key", cacheKey)
    .or("expires_at.is.null,expires_at.gt." + new Date().toISOString())
    .maybeSingle();

  if (!data) return null;
  return {
    resultText: data.result_text,
    resultType: data.result_type,
    model: data.model,
    createdAt: data.created_at
  };
}

export async function storeCachedAIResult(env, payload) {
  if (!hasDB(env)) return;

  await getDB(env)
    .from("ai_results_cache")
    .upsert({
      cache_key: payload.cacheKey,
      result_type: payload.resultType,
      story_id: payload.storyId ?? null,
      result_text: payload.resultText,
      model: payload.model ?? null,
      expires_at: payload.expiresAt ?? null
    });
}

// ── AI request receipts (billing dedup) ──────────────────────────────────────

export async function hasAIRequestReceipt(env, payload) {
  if (!hasDB(env)) return false;

  const { data } = await getDB(env)
    .from("ai_request_receipts")
    .select("user_id")
    .eq("user_id", payload.subscriberId)
    .eq("action", payload.action)
    .eq("story_id", payload.storyId)
    .eq("target_language", payload.targetLanguage ?? "")
    .eq("content_hash", payload.contentHash)
    .maybeSingle();

  return Boolean(data);
}

export async function storeAIRequestReceipt(env, payload) {
  if (!hasDB(env)) return;

  await getDB(env)
    .from("ai_request_receipts")
    .upsert({
      user_id: payload.subscriberId,
      action: payload.action,
      story_id: payload.storyId,
      target_language: payload.targetLanguage ?? "",
      content_hash: payload.contentHash
    });
}

// ── AI prompt configs ─────────────────────────────────────────────────────────

function normalizePromptConfigRow(r) {
  if (!r) return null;
  return {
    key: r.key,
    name: r.name,
    provider: r.provider,
    model: r.model,
    maxCompletionTokens: Number(r.max_completion_tokens ?? r.maxCompletionTokens ?? 0),
    systemPrompt: r.system_prompt ?? r.systemPrompt ?? "",
    userPromptTemplate: r.user_prompt_template ?? r.userPromptTemplate ?? "",
    settings: parsePromptSettings(r.settings ?? r.settings_json, {}),
    active: r.active ?? true,
    createdAt: r.created_at ?? r.createdAt ?? null,
    updatedAt: r.updated_at ?? r.updatedAt ?? null
  };
}

function fallbackPromptConfigs() {
  return AI_PROMPT_KEYS.map((key) => ({
    ...DEFAULT_AI_PROMPT_CONFIGS[key],
    settings: parsePromptSettings(DEFAULT_AI_PROMPT_CONFIGS[key].settings, {})
  }));
}

export async function getAIPromptConfig(env, key) {
  const legacyDB = getLegacyTestDB(env);
  if (!hasDB(env) && legacyDB) {
    const row = await legacyDB.prepare("SELECT * FROM ai_prompt_configs WHERE key = ?1").bind(key).first();
    return normalizePromptConfigRow(row) ?? fallbackPromptConfigs().find((c) => c.key === key) ?? null;
  }
  if (!hasDB(env)) return fallbackPromptConfigs().find((c) => c.key === key) ?? null;

  const { data } = await getDB(env)
    .from("ai_prompt_configs")
    .select("*")
    .eq("key", key)
    .maybeSingle();

  return normalizePromptConfigRow(data) ?? fallbackPromptConfigs().find((c) => c.key === key) ?? null;
}


// ── Image prompt optimizer configs ────────────────────────────────────────────

function normalizeImagePromptOptimizerConfigRow(r) {
  if (!r) return null;
  return imagePromptOptimizerConfigWithFallback({
    id: r.id == null ? null : Number(r.id),
    key: r.key ?? DEFAULT_IMAGE_PROMPT_OPTIMIZER_KEY,
    version: r.version ?? DEFAULT_IMAGE_PROMPT_OPTIMIZER_VERSION,
    name: r.name ?? DEFAULT_IMAGE_PROMPT_OPTIMIZER_CONFIG.name,
    optimizerProvider: r.optimizer_provider ?? r.provider ?? DEFAULT_IMAGE_PROMPT_OPTIMIZER_CONFIG.optimizerProvider,
    optimizerModel: r.optimizer_model ?? r.model ?? DEFAULT_IMAGE_PROMPT_OPTIMIZER_CONFIG.optimizerModel,
    generationProvider: r.generation_provider ?? DEFAULT_IMAGE_PROMPT_OPTIMIZER_CONFIG.generationProvider,
    generationModel: r.generation_model ?? DEFAULT_IMAGE_PROMPT_OPTIMIZER_CONFIG.generationModel,
    maxCompletionTokens: Number(r.max_completion_tokens ?? r.maxCompletionTokens ?? DEFAULT_IMAGE_PROMPT_OPTIMIZER_CONFIG.maxCompletionTokens),
    systemPrompt: r.system_prompt ?? r.systemPrompt ?? DEFAULT_IMAGE_PROMPT_OPTIMIZER_CONFIG.systemPrompt,
    userPromptTemplate: r.user_prompt_template ?? r.userPromptTemplate ?? DEFAULT_IMAGE_PROMPT_OPTIMIZER_CONFIG.userPromptTemplate,
    topicMatchers: r.topic_matchers ?? r.topicMatchers ?? [],
    keywordMatchers: r.keyword_matchers ?? r.keywordMatchers ?? [],
    routingPriority: r.routing_priority ?? r.routingPriority ?? DEFAULT_IMAGE_PROMPT_OPTIMIZER_CONFIG.routingPriority,
    fallback: r.fallback ?? DEFAULT_IMAGE_PROMPT_OPTIMIZER_CONFIG.fallback,
    settings: parsePromptSettings(r.settings ?? r.settings_json, DEFAULT_IMAGE_PROMPT_OPTIMIZER_CONFIG.settings),
    active: r.active ?? true,
    createdAt: r.created_at ?? r.createdAt ?? null,
    updatedAt: r.updated_at ?? r.updatedAt ?? null
  });
}

async function listImagePromptOptimizerConfigs(env, {
  key = null,
  version = null,
  activeOnly = true
} = {}) {
  if (!hasDB(env)) {
    return [imagePromptOptimizerConfigWithFallback({
      ...DEFAULT_IMAGE_PROMPT_OPTIMIZER_CONFIG,
      key: key ?? DEFAULT_IMAGE_PROMPT_OPTIMIZER_KEY,
      version: version ?? DEFAULT_IMAGE_PROMPT_OPTIMIZER_VERSION
    })];
  }

  let query = getDB(env)
    .from("image_prompt_optimizer_configs")
    .select("*");

  if (key) {
    query = query.eq("key", key);
  }

  if (version) {
    query = query.eq("version", version);
  } else if (activeOnly) {
    query = query.eq("active", true);
  }

  const { data } = await query.order("routing_priority", { ascending: true }).order("updated_at", { ascending: false });
  const rows = Array.isArray(data) ? data : (data ? [data] : []);
  return rows.map(normalizeImagePromptOptimizerConfigRow).filter(Boolean);
}

export async function getImagePromptOptimizerConfig(env, {
  id = null,
  key = DEFAULT_IMAGE_PROMPT_OPTIMIZER_KEY,
  version = null,
  activeOnly = true,
  randomActive = false,
  input = null
} = {}) {
  if (!hasDB(env)) {
    return imagePromptOptimizerConfigWithFallback({
      ...DEFAULT_IMAGE_PROMPT_OPTIMIZER_CONFIG,
      key: key ?? DEFAULT_IMAGE_PROMPT_OPTIMIZER_KEY,
      version: version ?? DEFAULT_IMAGE_PROMPT_OPTIMIZER_VERSION
    });
  }

  if (Number.isInteger(Number(id)) && Number(id) > 0) {
    const { data } = await getDB(env)
      .from("image_prompt_optimizer_configs")
      .select("*")
      .eq("id", Number(id))
      .maybeSingle();

    return normalizeImagePromptOptimizerConfigRow(data) ?? imagePromptOptimizerConfigWithFallback({
      ...DEFAULT_IMAGE_PROMPT_OPTIMIZER_CONFIG,
      key: DEFAULT_IMAGE_PROMPT_OPTIMIZER_KEY,
      version: DEFAULT_IMAGE_PROMPT_OPTIMIZER_VERSION
    });
  }

  if (input && !version) {
    const configs = await listImagePromptOptimizerConfigs(env, {
      key,
      activeOnly: true
    });
    return selectImagePromptOptimizerConfig(configs, input).config;
  }

  if (randomActive && !version) {
    const configs = await listImagePromptOptimizerConfigs(env, {
      key,
      activeOnly: true
    });
    if (configs.length > 0) {
      const selectedIndex = Math.floor(Math.random() * configs.length);
      return configs[selectedIndex];
    }
  }

  const configs = await listImagePromptOptimizerConfigs(env, {
    key,
    version,
    activeOnly
  });
  const data = configs[0] ?? null;

  return data ?? imagePromptOptimizerConfigWithFallback({
    ...DEFAULT_IMAGE_PROMPT_OPTIMIZER_CONFIG,
    key: key ?? DEFAULT_IMAGE_PROMPT_OPTIMIZER_KEY,
    version: version ?? DEFAULT_IMAGE_PROMPT_OPTIMIZER_VERSION
  });
}

export async function resolveImagePromptOptimizerConfig(env, options = {}) {
  const {
    id = null,
    key = DEFAULT_IMAGE_PROMPT_OPTIMIZER_KEY,
    version = null,
    activeOnly = true,
    randomActive = false,
    input = null
  } = options;

  if (Number.isInteger(Number(id)) && Number(id) > 0) {
    return {
      config: await getImagePromptOptimizerConfig(env, { id: Number(id) }),
      matchedTopics: [],
      matchedKeywords: [],
      fallbackReason: "explicit_id"
    };
  }

  if (version || !input) {
    return {
      config: await getImagePromptOptimizerConfig(env, { key, version, activeOnly, randomActive }),
      matchedTopics: [],
      matchedKeywords: [],
      fallbackReason: version ? "explicit_version" : (randomActive ? "random_active" : null)
    };
  }

  const configs = await listImagePromptOptimizerConfigs(env, {
    key,
    activeOnly
  });
  return selectImagePromptOptimizerConfig(configs, input);
}

export async function createImagePromptGeneration(env, payload) {
  if (!hasDB(env)) return null;

  const row = {
    story_id: payload.storyId ?? null,
    source: payload.source,
    optimizer_config_id: payload.optimizerConfigId ?? null,
    optimizer_key: payload.optimizerKey,
    optimizer_version: payload.optimizerVersion,
    optimizer_provider: payload.optimizerProvider,
    optimizer_model: payload.optimizerModel,
    optimizer_input: payload.optimizerInput ?? {},
    optimized_prompt: payload.optimizedPrompt ?? null,
    status: payload.status,
    latency_ms: payload.latencyMs ?? null,
    error_text: payload.errorText ?? null
  };

  const { data } = await getDB(env)
    .from("image_prompt_generations")
    .insert(row)
    .select("id")
    .maybeSingle();

  return data ? Number(data.id) : null;
}

export async function getImagePromptOptimizerStats(env, days = 30) {
  if (!hasDB(env)) return [];

  const { data } = await getDB(env).rpc("get_image_prompt_optimizer_stats", { p_days: days });
  return (data ?? []).map((r) => ({
    optimizerConfigId: Number(r.optimizer_config_id ?? 0) || null,
    optimizerKey: r.optimizer_key,
    optimizerVersion: r.optimizer_version,
    totalGenerated: Number(r.total_generated ?? 0),
    succeeded: Number(r.succeeded ?? 0),
    failed: Number(r.failed ?? 0),
    totalEngagements: Number(r.total_engagements ?? 0),
    totalImpressions: Number(r.total_impressions ?? 0),
    engagementRate: Number(r.engagement_rate ?? 0)
  }));
}

// ── Prompt run events ─────────────────────────────────────────────────────────

export async function createPromptRunEvent(env, payload) {
  const legacyDB = getLegacyTestDB(env);
  if (!hasDB(env) && legacyDB) {
    const cost = serializeCostFields(payload.cost);
    await legacyDB.prepare(`
      INSERT INTO prompt_run_events
        (source, prompt_kind, prompt_key, prompt_version, optimizer_config_id, provider, model, modality, status, latency_ms, cache_hit,
         request_excerpt, response_excerpt, artifact_url, error_text, story_id, cost_usd, cost_currency, cost_estimated,
         pricing_source, cost_details_json, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)
    `).bind(
      payload.source,
      payload.promptKind,
      payload.promptKey,
      payload.promptVersion ?? null,
      payload.optimizerConfigId ?? null,
      payload.provider,
      payload.model ?? null,
      payload.modality,
      payload.status,
      payload.latencyMs ?? null,
      payload.cacheHit ?? false ? 1 : 0,
      payload.requestExcerpt ?? null,
      payload.responseExcerpt ?? null,
      payload.artifactUrl ?? null,
      payload.errorText ?? null,
      payload.storyId ?? null,
      cost.costUsd,
      cost.costCurrency,
      cost.costEstimated ?? false ? 1 : 0,
      cost.pricingSource,
      cost.costDetailsJson,
      payload.createdAt ?? new Date().toISOString()
    ).run();
    return;
  }
  if (!hasDB(env)) return;

  const cost = serializeCostFields(payload.cost);

  await getDB(env)
    .from("prompt_run_events")
    .insert({
      source: payload.source,
      prompt_kind: payload.promptKind,
      prompt_key: payload.promptKey,
      prompt_version: payload.promptVersion ?? null,
      optimizer_config_id: payload.optimizerConfigId ?? null,
      provider: payload.provider,
      model: payload.model ?? null,
      modality: payload.modality,
      status: payload.status,
      latency_ms: payload.latencyMs ?? null,
      cache_hit: payload.cacheHit ?? false,
      request_excerpt: payload.requestExcerpt ?? null,
      response_excerpt: payload.responseExcerpt ?? null,
      artifact_url: payload.artifactUrl ?? null,
      error_text: payload.errorText ?? null,
      story_id: payload.storyId ?? null,
      cost_usd: cost.costUsd,
      cost_currency: cost.costCurrency,
      cost_estimated: cost.costEstimated,
      pricing_source: cost.pricingSource,
      cost_details: cost.costDetailsJson ? JSON.parse(cost.costDetailsJson) : null
    });
}

export async function updatePublishedFeedEntryMediaProjection(env, storyId, fields) {
  if (!hasDB(env)) return;

  await getDB(env)
    .from("published_feed_entries")
    .update({
      media_type: fields.mediaType ?? null,
      media_provider: fields.mediaProvider ?? null,
      media_model: fields.mediaModel ?? null,
      generation_status: fields.generationStatus ?? null,
      generation_latency_ms: fields.generationLatencyMs ?? null,
      generation_cost_usd: fields.generationCostUsd ?? null
    })
    .eq("story_id", storyId);
}

// ── RSS sources ───────────────────────────────────────────────────────────────

export async function getRSSSources(env, { category = null, activeOnly = true, dueForFetch = false } = {}) {
  if (!hasDB(env)) return [];

  let query = getDB(env).from("rss_sources").select("*");
  if (activeOnly) query = query.eq("active", true);
  if (category) query = query.eq("category", category);

  const { data } = await query;
  const sources = rows(data);
  return dueForFetch ? sources.filter((source) => isRSSSourceDueForFetch(source)) : sources;
}

export async function getRSSSourceById(env, id) {
  if (!hasDB(env)) return null;

  const { data } = await getDB(env)
    .from("rss_sources")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  return row(data);
}

export async function upsertRSSSource(env, source) {
  if (!hasDB(env)) return null;

  const payload = {
    name: source.name,
    feed_url: source.feed_url,
    category: source.category,
    tier: source.tier ?? 2,
    reliability_score: source.reliability_score ?? 0.5,
    language: source.language ?? "en",
    active: source.active ?? true,
    fetch_interval_minutes: source.fetch_interval_minutes ?? 30
  };

  if (source.id) {
    await getDB(env).from("rss_sources").update(payload).eq("id", source.id);
    return source.id;
  }

  const { data } = await getDB(env)
    .from("rss_sources")
    .insert(payload)
    .select("id")
    .single();

  return data?.id ?? null;
}

export async function setRSSSourceActive(env, id, active) {
  if (!hasDB(env)) return false;
  await getDB(env).from("rss_sources").update({ active }).eq("id", id);
  return true;
}

export async function markSourceFetched(env, sourceId) {
  if (!hasDB(env)) return;
  await getDB(env)
    .from("rss_sources")
    .update({ last_fetched_at: new Date().toISOString() })
    .eq("id", sourceId);
}

export async function insertRSSItem(env, item) {
  if (!hasDB(env)) return false;

  const { error } = await getDB(env)
    .from("rss_items")
    .insert({
      story_id: item.storyId,
      source_id: item.sourceId,
      guid: item.guid,
      url: item.url,
      canonical_url: item.canonicalUrl,
      title: item.title,
      description: item.description ?? null,
      author: item.author ?? null,
      published_at: item.publishedAt ?? null
    });

  if (!error) return true;
  if (error.code === "23505") return false;

  log.warn({
    event: "rss_item_insert_fail",
    storyId: item.storyId,
    sourceId: item.sourceId,
    code: error.code,
    error: error.message
  });
  return false;
}

export async function markRSSItemCrawlFailure(env, storyId, reason) {
  if (!hasDB(env)) return false;

  await getDB(env)
    .from("rss_items")
    .update({
      crawl_failed: true,
      crawl_failure_reason: reason ?? "unknown",
      crawl_failed_at: new Date().toISOString()
    })
    .eq("story_id", storyId);

  return true;
}

export async function clearRSSItemCrawlFailure(env, storyId) {
  if (!hasDB(env)) return false;

  await getDB(env)
    .from("rss_items")
    .update({
      crawl_failed: false,
      crawl_failure_reason: null,
      crawl_failed_at: null
    })
    .eq("story_id", storyId);

  return true;
}

export async function getRSSSourceIdByStoryId(env, storyId) {
  if (!hasDB(env)) return null;
  const { data } = await getDB(env)
    .from("rss_items")
    .select("source_id")
    .eq("story_id", storyId)
    .limit(1)
    .maybeSingle();
  return data?.source_id ?? null;
}

export async function getStoryContentMetadataByStoryId(env, storyId) {
  if (!hasDB(env)) return null;

  const { data } = await getDB(env)
    .from("rss_items")
    .select("url, canonical_url, rss_sources!inner(feed_url, tier)")
    .eq("story_id", storyId)
    .order("rss_sources(tier)", { ascending: true })
    .order("ingested_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!data) return null;

  return {
    url: data.url ?? null,
    canonicalUrl: data.canonical_url ?? null,
    feedUrl: data.rss_sources?.feed_url ?? null
  };
}

export async function updateStoryStats(env) {
  if (!hasDB(env)) return 0;

  const rows = await queryStoryStats(env, 90);
  if (!rows.length) return 0;

  const updates = rows
    .map((row) => ({
      story_id: Number.parseInt(row.story_id, 10),
      impression_count: Number(row.impression_count ?? 0),
      engagement_count: Number(row.engagement_count ?? 0)
    }))
    .filter((row) => Number.isInteger(row.story_id));

  if (updates.length === 0) return 0;

  await Promise.all(updates.map((row) => getDB(env)
    .from("published_feed_entries")
    .update({
      impression_count: row.impression_count,
      engagement_count: row.engagement_count
    })
    .eq("story_id", row.story_id)));

  return updates.length;
}

export async function cleanupOldUserEvents(env, days = 30) {
  void env;
  void days;
  return 0;
}
