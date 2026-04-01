import { createClient } from "@supabase/supabase-js";
import { fixtureFeed } from "./fixtures.mjs";
import { normalizePersistedCostFields, serializeCostFields } from "./model-catalog.mjs";
import { AI_PROMPT_KEYS, DEFAULT_AI_PROMPT_CONFIGS, parsePromptSettings } from "./prompt-config.mjs";

function getDB(env) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false }
  });
}

function hasDB(env) {
  return Boolean(env?.SUPABASE_URL && env?.SUPABASE_SERVICE_ROLE_KEY);
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

function fixturePublishedFeed(cursor = null, limit = 20) {
  return fixtureFeed
    .slice()
    .sort((a, b) => b.publishSequence - a.publishSequence)
    .filter((item) => cursor == null || item.publishSequence < cursor)
    .slice(0, limit);
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

  return (data ?? []).map((r) => ({
    storyId: r.story_id,
    publishSequence: r.publish_sequence,
    sourceEndpoint: r.source_endpoint,
    publishedAt: r.published_at,
    mediaUrl: r.media_url,
    mediaStatus: r.media_status,
    headline: r.headline
  }));
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
      media_url: payload.mediaUrl ?? null,
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

export async function storeReadableContent(env, payload) {
  if (!hasDB(env)) return;

  await getDB(env)
    .from("story_content")
    .upsert({
      story_id: payload.storyId,
      source_kind: payload.sourceKind,
      extracted_text: payload.extractedText,
      updated_at: payload.updatedAt
    });
}

export async function getReadableContent(env, storyId) {
  if (!hasDB(env)) return null;

  const { data } = await getDB(env)
    .from("story_content")
    .select("extracted_text")
    .eq("story_id", storyId)
    .maybeSingle();

  return data ? { extractedText: data.extracted_text } : null;
}

export async function storeHeadline(env, storyId, headline, headlinePrompt) {
  if (!hasDB(env)) return;

  await getDB(env)
    .from("story_content")
    .update({ ai_headline: headline, headline_prompt: headlinePrompt ?? null })
    .eq("story_id", storyId);
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
      prompt_template_id: payload.promptTemplateId ?? null,
      image_prompt: payload.imagePrompt ?? null,
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
    .eq("attempts", 0)
    .is("prompt_template_id", null);
}

export async function cleanupStaleMedia(env, days = 7) {
  if (!hasDB(env)) return 0;

  const { data } = await getDB(env).rpc("cleanup_stale_media", { p_days: days });
  return Number(data ?? 0);
}

export async function getPromptTemplateStats(env, days = 30) {
  if (!hasDB(env)) return [];

  const { data } = await getDB(env).rpc("get_prompt_template_stats", { p_days: days });
  return (data ?? []).map((r) => ({
    templateId: r.template_id,
    templateName: r.template_name,
    totalGenerated: Number(r.total_generated),
    succeeded: Number(r.succeeded),
    failed: Number(r.failed),
    deadLettered: Number(r.dead_lettered),
    totalEngagements: Number(r.total_engagements),
    totalImpressions: Number(r.total_impressions),
    engagementRate: Number(r.engagement_rate)
  }));
}

// ── User events ───────────────────────────────────────────────────────────────

export async function batchInsertEvents(env, userId, events) {
  if (!hasDB(env) || events.length === 0) return { stored: 0 };

  try {
    const { data } = await getDB(env).rpc("insert_events_deduped", {
      p_user_id: userId,
      p_events: JSON.stringify(events)
    });

    return { stored: Number(data ?? 0) };
  } catch {
    const rowsToInsert = events.map((event) => ({
      event_id: event.eventId,
      user_id: userId,
      story_id: event.storyId,
      event_type: event.eventType,
      occurred_at: event.occurredAt,
      session_id: event.sessionId ?? null,
      surface: event.surface ?? "unknown",
      position: event.position ?? null,
      feed_mode: event.feedMode ?? null,
      dwell_ms: event.dwellMs ?? null,
      metadata_json: event.metadata ?? null,
      label: event.label ?? null,
      source_endpoint: event.sourceEndpoint ?? null,
      topic_primary: event.topicPrimary ?? null,
      media_type: event.mediaType ?? null,
      ai_action: event.aiAction ?? null,
      ai_cached: event.aiCached ?? null,
      ai_credits_used: event.aiCreditsUsed ?? null,
      created_at: event.occurredAt
    }));

    const { data, error } = await getDB(env)
      .from("user_events")
      .upsert(rowsToInsert, { onConflict: "event_id", ignoreDuplicates: true })
      .select("event_id");

    if (error) {
      throw error;
    }

    return { stored: data?.length ?? rowsToInsert.length };
  }
}

export async function enrichEventsWithStoryContext(env, events) {
  if (!hasDB(env) || !events?.length) {
    return events;
  }

  const storyIds = [...new Set(events.map((event) => event.storyId).filter(Number.isInteger))];
  if (storyIds.length === 0) {
    return events;
  }

  const { data } = await getDB(env)
    .from("published_feed_entries")
    .select("story_id, source_endpoint, media_type, topics")
    .in("story_id", storyIds);

  const byStoryId = new Map((data ?? []).map((row) => [row.story_id, row]));
  return events.map((event) => {
    const story = byStoryId.get(event.storyId);
    let topicPrimary = event.topicPrimary ?? null;
    if (!topicPrimary && story?.topics) {
      try {
        const parsedTopics = typeof story.topics === "string" ? JSON.parse(story.topics) : story.topics;
        topicPrimary = Array.isArray(parsedTopics) ? parsedTopics[0] ?? null : null;
      } catch {
        topicPrimary = null;
      }
    }

    return {
      ...event,
      sourceEndpoint: event.sourceEndpoint ?? story?.source_endpoint ?? null,
      mediaType: event.mediaType ?? story?.media_type ?? null,
      topicPrimary
    };
  });
}

// ── User profiles ─────────────────────────────────────────────────────────────

export async function getUserProfile(env, userId) {
  if (!hasDB(env)) return null;

  const { data } = await getDB(env)
    .from("user_profiles")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (!data) return null;
  return {
    userId: data.user_id,
    platform: data.platform,
    topicScores: data.topic_scores,
    endpointScores: data.endpoint_scores,
    mediaPref: data.media_pref,
    totalImpressions: data.total_impressions,
    totalEngagements: data.total_engagements,
    updatedAt: data.updated_at
  };
}

export async function upsertUserProfile(env, userId, profile) {
  if (!hasDB(env)) return;

  await getDB(env)
    .from("user_profiles")
    .upsert({
      user_id: userId,
      topic_scores: profile.topicScores ?? {},
      endpoint_scores: profile.endpointScores ?? {},
      media_pref: profile.mediaPref ?? {},
      total_impressions: profile.totalImpressions ?? 0,
      total_engagements: profile.totalEngagements ?? 0,
      updated_at: new Date().toISOString()
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

// ── Recommendation ────────────────────────────────────────────────────────────

export async function getRecommendationCandidates(env, limit = 200) {
  if (!hasDB(env)) return [];

  let data = null;
  try {
    const result = await getDB(env).rpc("get_recommendation_candidates", { p_limit: limit });
    data = result.data ?? null;
  } catch {
    const fallback = await getDB(env)
      .from("published_feed_entries")
      .select("*")
      .order("publish_sequence", { ascending: false })
      .limit(limit);
    data = fallback.data ?? [];
  }
  return (data ?? []).map((r) => ({
    storyId: r.story_id,
    publishSequence: r.publish_sequence,
    sourceEndpoint: r.source_endpoint,
    publishedAt: r.published_at,
    topics: r.topics,
    qualityScore: r.quality_score,
    noveltyScore: r.novelty_score,
    engagementCount: r.engagement_count,
    impressionCount: r.impression_count,
    mediaUrl: r.media_url,
    mediaStatus: r.media_status,
    headline: r.headline,
    publisher: r.publisher,
    language: r.language,
    entities: r.entities,
    publisherTier: r.publisher_tier,
    sourceReliabilityScore: r.source_reliability_score,
    hasAuthor: r.has_author,
    articleLength: r.article_length,
    ctr5m: r.ctr_5m,
    ctr30m: r.ctr_30m,
    ctr2h: r.ctr_2h,
    saveRate2h: r.save_rate_2h,
    skipRate30m: r.skip_rate_30m,
    completionRate2h: r.completion_rate_2h,
    mediaType: r.media_type,
    mediaProvider: r.media_provider,
    mediaModel: r.media_model,
    generationStatus: r.generation_status,
    generationLatencyMs: r.generation_latency_ms,
    generationCostUsd: r.generation_cost_usd,
    promptTemplateId: r.prompt_template_id,
    promptTemplateName: r.prompt_template_name,
    topicCount: r.topic_count,
    entityCount: r.entity_count,
    detailOpenRate2h: r.detail_open_rate_2h,
    shareRate2h: r.share_rate_2h,
    hideRate2h: r.hide_rate_2h,
    aiActionRate24h: r.ai_action_rate_24h,
    readableUrl: r.readable_url
  }));
}

export async function getSeenStoryIds(env, userId, days = 7) {
  if (!hasDB(env)) return [];

  const since = new Date(Date.now() - days * 86400000).toISOString();
  const { data } = await getDB(env)
    .from("user_events")
    .select("story_id")
    .eq("user_id", userId)
    .eq("event_type", "impression")
    .gte("created_at", since);

  return [...new Set((data ?? []).map((r) => r.story_id))];
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

export async function listAIPromptConfigs(env) {
  const legacyDB = getLegacyTestDB(env);
  if (!hasDB(env) && legacyDB) {
    const { results } = await legacyDB.prepare("SELECT * FROM ai_prompt_configs ORDER BY key").all();
    const byKey = new Map((results ?? []).map((r) => [r.key, normalizePromptConfigRow(r)]));
    return AI_PROMPT_KEYS.map((key) => byKey.get(key) ?? fallbackPromptConfigs().find((c) => c.key === key));
  }
  if (!hasDB(env)) return fallbackPromptConfigs();

  const { data } = await getDB(env)
    .from("ai_prompt_configs")
    .select("*")
    .order("key");

  const byKey = new Map((data ?? []).map((r) => [r.key, normalizePromptConfigRow(r)]));
  return AI_PROMPT_KEYS.map((key) => byKey.get(key) ?? fallbackPromptConfigs().find((c) => c.key === key));
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

export async function upsertAIPromptConfig(env, payload) {
  const legacyDB = getLegacyTestDB(env);
  if (!hasDB(env) && legacyDB) {
    await legacyDB.prepare(`
      INSERT INTO ai_prompt_configs
        (key, name, provider, model, max_completion_tokens, system_prompt, user_prompt_template, settings_json, active, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
    `).bind(
      payload.key,
      payload.name,
      payload.provider,
      payload.model,
      payload.maxCompletionTokens,
      payload.systemPrompt,
      payload.userPromptTemplate,
      JSON.stringify(payload.settings ?? {}),
      payload.active ?? true,
      payload.updatedAt ?? new Date().toISOString()
    ).run();
    return getAIPromptConfig(env, payload.key);
  }
  if (!hasDB(env)) return normalizePromptConfigRow(payload);

  await getDB(env)
    .from("ai_prompt_configs")
    .upsert({
      key: payload.key,
      name: payload.name,
      provider: payload.provider,
      model: payload.model,
      max_completion_tokens: payload.maxCompletionTokens,
      system_prompt: payload.systemPrompt,
      user_prompt_template: payload.userPromptTemplate,
      settings: payload.settings ?? {},
      active: payload.active ?? true,
      updated_at: payload.updatedAt ?? new Date().toISOString()
    });

  return getAIPromptConfig(env, payload.key);
}

// ── Prompt templates ──────────────────────────────────────────────────────────

function normalizePromptTemplateRow(r) {
  if (!r) return null;
  return {
    id: r.id == null ? null : Number(r.id),
    name: r.name,
    description: r.description ?? null,
    templateText: r.template_text ?? r.templateText ?? "",
    active: r.active ?? true,
    modality: r.modality ?? "image",
    provider: r.provider ?? "fal",
    model: r.model ?? null,
    settings: parsePromptSettings(r.settings ?? r.settings_json, {}),
    createdBy: r.created_by ?? r.createdBy ?? null,
    createdAt: r.created_at ?? r.createdAt ?? null,
    updatedAt: r.updated_at ?? r.updatedAt ?? null
  };
}

export async function listPromptTemplates(env, { modality = null } = {}) {
  const legacyDB = getLegacyTestDB(env);
  if (!hasDB(env) && legacyDB) {
    const { results } = await legacyDB.prepare("SELECT * FROM prompt_templates ORDER BY active DESC, updated_at DESC, id DESC").all();
    return (results ?? [])
      .map(normalizePromptTemplateRow)
      .filter((row) => !modality || row?.modality === modality);
  }
  if (!hasDB(env)) return [];

  let query = getDB(env)
    .from("prompt_templates")
    .select("*")
    .order("active", { ascending: false })
    .order("updated_at", { ascending: false })
    .order("id", { ascending: false });

  if (modality) query = query.eq("modality", modality);

  const { data } = await query;
  return (data ?? []).map(normalizePromptTemplateRow);
}

export async function getPromptTemplateById(env, templateId) {
  const legacyDB = getLegacyTestDB(env);
  if (!hasDB(env) && legacyDB) {
    const row = await legacyDB.prepare("SELECT * FROM prompt_templates WHERE id = ?1").bind(templateId).first();
    return normalizePromptTemplateRow(row);
  }
  if (!hasDB(env)) return null;

  const { data } = await getDB(env)
    .from("prompt_templates")
    .select("*")
    .eq("id", templateId)
    .maybeSingle();

  return normalizePromptTemplateRow(data);
}

export async function upsertPromptTemplate(env, payload) {
  const legacyDB = getLegacyTestDB(env);
  if (!hasDB(env) && legacyDB) {
    if (payload.id) {
      await legacyDB.prepare(`
        UPDATE prompt_templates
        SET name = ?2,
            description = ?3,
            template_text = ?4,
            active = ?5,
            modality = ?6,
            provider = ?7,
            model = ?8,
            settings_json = ?9,
            created_by = ?10,
            updated_at = ?11
        WHERE id = ?1
      `).bind(
        payload.id,
        payload.name,
        payload.description ?? null,
        payload.templateText,
        payload.active ?? true,
        payload.modality ?? "image",
        payload.provider ?? "fal",
        payload.model ?? null,
        JSON.stringify(payload.settings ?? {}),
        payload.createdBy ?? null,
        payload.updatedAt ?? new Date().toISOString()
      ).run();
      return getPromptTemplateById(env, payload.id);
    }

    const created = await legacyDB.prepare(`
      INSERT INTO prompt_templates
        (name, description, template_text, active, modality, provider, model, settings_json, created_by, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
    `).bind(
      payload.name,
      payload.description ?? null,
      payload.templateText,
      payload.active ?? true,
      payload.modality ?? "image",
      payload.provider ?? "fal",
      payload.model ?? null,
      JSON.stringify(payload.settings ?? {}),
      payload.createdBy ?? null,
      payload.createdAt ?? new Date().toISOString(),
      payload.updatedAt ?? new Date().toISOString()
    ).run();
    return getPromptTemplateById(env, created?.meta?.last_row_id ?? null);
  }
  if (!hasDB(env)) return normalizePromptTemplateRow(payload);

  const record = {
    name: payload.name,
    description: payload.description ?? null,
    template_text: payload.templateText,
    active: payload.active ?? true,
    modality: payload.modality ?? "image",
    provider: payload.provider ?? "fal",
    model: payload.model ?? null,
    settings: payload.settings ?? {},
    created_by: payload.createdBy ?? null,
    updated_at: payload.updatedAt ?? new Date().toISOString()
  };

  if (payload.id) {
    await getDB(env).from("prompt_templates").update(record).eq("id", payload.id);
    return getPromptTemplateById(env, payload.id);
  }

  const { data } = await getDB(env)
    .from("prompt_templates")
    .insert({ ...record, created_at: payload.createdAt ?? new Date().toISOString() })
    .select()
    .single();

  return normalizePromptTemplateRow(data);
}

export async function getActivePromptTemplate(env, { modality = "image", provider = null } = {}) {
  const legacyDB = getLegacyTestDB(env);
  if (!hasDB(env) && legacyDB) {
    const templates = await listPromptTemplates(env, { modality });
    return templates.find((template) => template.active && (!provider || template.provider === provider)) ?? null;
  }
  if (!hasDB(env)) return null;

  let query = getDB(env)
    .from("prompt_templates")
    .select("*")
    .eq("active", true)
    .eq("modality", modality)
    .order("updated_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1);

  if (provider) query = query.eq("provider", provider);

  const { data } = await query;
  return normalizePromptTemplateRow(data?.[0] ?? null);
}

export async function getRandomActivePromptTemplate(env, { modality = "image", provider = null } = {}) {
  if (!hasDB(env)) return null;

  // Get all active templates for the modality/provider, then pick one randomly
  let query = getDB(env)
    .from("prompt_templates")
    .select("*")
    .eq("active", true)
    .eq("modality", modality);

  if (provider) query = query.eq("provider", provider);

  const { data } = await query;
  if (!data?.length) return null;
  return normalizePromptTemplateRow(data[Math.floor(Math.random() * data.length)]);
}

// ── Admin ─────────────────────────────────────────────────────────────────────

export async function getAdminUserByUsername(env, username) {
  const legacyDB = getLegacyTestDB(env);
  if (!hasDB(env) && legacyDB) {
    const data = await legacyDB.prepare("SELECT * FROM admin_users WHERE username = ?1").bind(username).first();
    if (!data) return null;
    return {
      id: data.id,
      username: data.username,
      passwordSalt: data.passwordSalt ?? data.password_salt,
      passwordHash: data.passwordHash ?? data.password_hash,
      active: data.active,
      createdAt: data.createdAt ?? data.created_at,
      updatedAt: data.updatedAt ?? data.updated_at
    };
  }
  if (!hasDB(env)) return null;

  const { data } = await getDB(env)
    .from("admin_users")
    .select("id, username, password_salt, password_hash, active, created_at, updated_at")
    .eq("username", username)
    .maybeSingle();

  if (!data) return null;
  return {
    id: data.id,
    username: data.username,
    passwordSalt: data.password_salt,
    passwordHash: data.password_hash,
    active: data.active,
    createdAt: data.created_at,
    updatedAt: data.updated_at
  };
}

export async function upsertAdminUser(env, payload) {
  const legacyDB = getLegacyTestDB(env);
  if (!hasDB(env) && legacyDB) {
    await legacyDB.prepare(`
      INSERT INTO admin_users
        (username, password_salt, password_hash, active, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5)
    `).bind(
      payload.username,
      payload.passwordSalt,
      payload.passwordHash,
      payload.active ?? true,
      payload.updatedAt ?? new Date().toISOString()
    ).run();
    return getAdminUserByUsername(env, payload.username);
  }
  if (!hasDB(env)) return null;

  await getDB(env)
    .from("admin_users")
    .upsert({
      username: payload.username,
      password_salt: payload.passwordSalt,
      password_hash: payload.passwordHash,
      active: payload.active ?? true,
      updated_at: payload.updatedAt ?? new Date().toISOString()
    }, { onConflict: "username" });

  return getAdminUserByUsername(env, payload.username);
}

export async function createAdminSession(env, payload) {
  const legacyDB = getLegacyTestDB(env);
  if (!hasDB(env) && legacyDB) {
    await legacyDB.prepare(`
      INSERT INTO admin_sessions
        (id, user_id, session_hash, access_email, access_subject, created_at, expires_at, last_seen_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
    `).bind(
      payload.id,
      payload.userId,
      payload.sessionHash,
      payload.accessEmail ?? null,
      payload.accessSubject ?? null,
      payload.createdAt ?? new Date().toISOString(),
      payload.expiresAt,
      payload.lastSeenAt ?? new Date().toISOString()
    ).run();
    return;
  }
  if (!hasDB(env)) return null;

  await getDB(env)
    .from("admin_sessions")
    .insert({
      id: payload.id,
      user_id: payload.userId,
      session_hash: payload.sessionHash,
      access_email: payload.accessEmail ?? null,
      access_subject: payload.accessSubject ?? null,
      expires_at: payload.expiresAt,
      last_seen_at: payload.lastSeenAt ?? new Date().toISOString()
    });
}

export async function getAdminSessionByHash(env, sessionHash) {
  const legacyDB = getLegacyTestDB(env);
  if (!hasDB(env) && legacyDB) {
    const r = await legacyDB.prepare("SELECT * FROM admin_sessions s WHERE s.session_hash = ?1").bind(sessionHash).first();
    if (!r) return null;
    return {
      id: r.id,
      userId: r.userId ?? r.user_id,
      sessionHash: r.sessionHash ?? r.session_hash,
      accessEmail: r.accessEmail ?? r.access_email,
      accessSubject: r.accessSubject ?? r.access_subject,
      createdAt: r.createdAt ?? r.created_at,
      expiresAt: r.expiresAt ?? r.expires_at,
      lastSeenAt: r.lastSeenAt ?? r.last_seen_at,
      username: r.username,
      userActive: r.userActive ?? r.user_active
    };
  }
  if (!hasDB(env)) return null;

  const { data } = await getDB(env).rpc("get_admin_session_by_hash", { p_hash: sessionHash });
  const r = data?.[0];
  if (!r) return null;
  return {
    id: r.id,
    userId: r.user_id,
    sessionHash: r.session_hash,
    accessEmail: r.access_email,
    accessSubject: r.access_subject,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    lastSeenAt: r.last_seen_at,
    username: r.username,
    userActive: r.user_active
  };
}

export async function touchAdminSession(env, sessionHash) {
  const legacyDB = getLegacyTestDB(env);
  if (!hasDB(env) && legacyDB) {
    await legacyDB.prepare("UPDATE admin_sessions SET last_seen_at = ?2 WHERE session_hash = ?1")
      .bind(sessionHash, new Date().toISOString())
      .run();
    return;
  }
  if (!hasDB(env)) return;

  await getDB(env)
    .from("admin_sessions")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("session_hash", sessionHash);
}

export async function deleteAdminSession(env, sessionHash) {
  const legacyDB = getLegacyTestDB(env);
  if (!hasDB(env) && legacyDB) {
    await legacyDB.prepare("DELETE FROM admin_sessions WHERE session_hash = ?1").bind(sessionHash).run();
    return;
  }
  if (!hasDB(env)) return;

  await getDB(env).from("admin_sessions").delete().eq("session_hash", sessionHash);
}

export async function createAdminAuditLog(env, payload) {
  const legacyDB = getLegacyTestDB(env);
  if (!hasDB(env) && legacyDB) {
    await legacyDB.prepare(`
      INSERT INTO admin_audit_log
        (user_id, username, action, target_type, target_id, details_json)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6)
    `).bind(
      payload.userId ?? null,
      payload.username ?? null,
      payload.action,
      payload.targetType ?? null,
      payload.targetId ?? null,
      payload.detailsJson ? (typeof payload.detailsJson === "string" ? payload.detailsJson : JSON.stringify(payload.detailsJson)) : null
    ).run();
    return;
  }
  if (!hasDB(env)) return;

  await getDB(env)
    .from("admin_audit_log")
    .insert({
      user_id: payload.userId ?? null,
      username: payload.username ?? null,
      action: payload.action,
      target_type: payload.targetType ?? null,
      target_id: payload.targetId ?? null,
      details: payload.detailsJson ? (typeof payload.detailsJson === "string" ? JSON.parse(payload.detailsJson) : payload.detailsJson) : null
    });
}

// ── Prompt run events ─────────────────────────────────────────────────────────

export async function createPromptRunEvent(env, payload) {
  const legacyDB = getLegacyTestDB(env);
  if (!hasDB(env) && legacyDB) {
    const cost = serializeCostFields(payload.cost);
    await legacyDB.prepare(`
      INSERT INTO prompt_run_events
        (source, prompt_kind, prompt_key, prompt_template_id, provider, model, modality, status, latency_ms, cache_hit,
         request_excerpt, response_excerpt, artifact_url, error_text, story_id, cost_usd, cost_currency, cost_estimated,
         pricing_source, cost_details_json, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)
    `).bind(
      payload.source,
      payload.promptKind,
      payload.promptKey,
      payload.promptTemplateId ?? null,
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
      prompt_template_id: payload.promptTemplateId ?? null,
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
      generation_cost_usd: fields.generationCostUsd ?? null,
      prompt_template_id: fields.promptTemplateId ?? null,
      prompt_template_name: fields.promptTemplateName ?? null
    })
    .eq("story_id", storyId);
}

export async function listPromptRunEvents(env, { days = 30, limit = 50 } = {}) {
  const legacyDB = getLegacyTestDB(env);
  if (!hasDB(env) && legacyDB) {
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const { results } = await legacyDB.prepare("SELECT * FROM prompt_run_events WHERE created_at >= ?1 ORDER BY created_at DESC LIMIT ?2")
      .bind(since, limit)
      .all();
    return (results ?? []).map((r) => ({
      ...r,
      promptKind: r.prompt_kind,
      promptKey: r.prompt_key,
      promptTemplateId: r.prompt_template_id,
      latencyMs: r.latency_ms,
      cacheHit: r.cache_hit,
      requestExcerpt: r.request_excerpt,
      responseExcerpt: r.response_excerpt,
      artifactUrl: r.artifact_url,
      errorText: r.error_text,
      storyId: r.story_id,
      costUsd: r.cost_usd,
      costCurrency: r.cost_currency,
      costEstimated: r.cost_estimated,
      pricingSource: r.pricing_source,
      createdAt: r.created_at,
      costDetailsJson: r.cost_details_json ?? null,
      ...normalizePersistedCostFields({
        cost_usd: r.cost_usd,
        cost_currency: r.cost_currency,
        cost_estimated: r.cost_estimated,
        pricing_source: r.pricing_source,
        cost_details_json: r.cost_details_json ?? null
      })
    }));
  }
  if (!hasDB(env)) return [];

  const since = new Date(Date.now() - days * 86400000).toISOString();
  const { data } = await getDB(env)
    .from("prompt_run_events")
    .select("*")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(limit);

  return (data ?? []).map((r) => ({
    id: r.id,
    source: r.source,
    promptKind: r.prompt_kind,
    promptKey: r.prompt_key,
    promptTemplateId: r.prompt_template_id,
    provider: r.provider,
    model: r.model,
    modality: r.modality,
    status: r.status,
    latencyMs: r.latency_ms,
    cacheHit: r.cache_hit,
    requestExcerpt: r.request_excerpt,
    responseExcerpt: r.response_excerpt,
    artifactUrl: r.artifact_url,
    errorText: r.error_text,
    storyId: r.story_id,
    costUsd: r.cost_usd,
    costCurrency: r.cost_currency,
    costEstimated: r.cost_estimated,
    pricingSource: r.pricing_source,
    costDetailsJson: r.cost_details ? JSON.stringify(r.cost_details) : null,
    createdAt: r.created_at,
    ...normalizePersistedCostFields(r)
  }));
}

export async function getPromptRunOverview(env, { days = 30 } = {}) {
  const legacyDB = getLegacyTestDB(env);
  if (!hasDB(env) && legacyDB) {
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const r = await legacyDB.prepare("SELECT COUNT(*) AS totalRuns FROM prompt_run_events WHERE created_at >= ?1").bind(since).first();
    return {
      totalRuns: Number(r?.totalRuns ?? 0),
      succeeded: Number(r?.succeeded ?? 0),
      failed: Number(r?.failed ?? 0),
      cacheHits: Number(r?.cacheHits ?? 0),
      averageLatencyMs: Number(r?.averageLatencyMs ?? 0)
    };
  }
  if (!hasDB(env)) return { totalRuns: 0, succeeded: 0, failed: 0, cacheHits: 0, averageLatencyMs: 0 };

  const { data } = await getDB(env).rpc("get_prompt_run_overview", { p_days: days });
  const r = data?.[0] ?? {};
  return {
    totalRuns: Number(r.total_runs ?? 0),
    succeeded: Number(r.succeeded ?? 0),
    failed: Number(r.failed ?? 0),
    cacheHits: Number(r.cache_hits ?? 0),
    averageLatencyMs: Number(r.average_latency_ms ?? 0)
  };
}

export async function getPromptRunStats(env, { days = 30 } = {}) {
  const legacyDB = getLegacyTestDB(env);
  if (!hasDB(env) && legacyDB) {
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const { results } = await legacyDB.prepare("SELECT * FROM prompt_run_events WHERE created_at >= ?1 GROUP BY prompt_kind, prompt_key, provider, modality")
      .bind(since)
      .all();
    return (results ?? []).map((r) => ({
      promptKind: r.promptKind ?? r.prompt_kind,
      promptKey: r.promptKey ?? r.prompt_key,
      provider: r.provider,
      modality: r.modality,
      totalRuns: Number(r.totalRuns ?? 0),
      succeeded: Number(r.succeeded ?? 0),
      failed: Number(r.failed ?? 0),
      cacheHits: Number(r.cacheHits ?? 0),
      averageLatencyMs: Number(r.averageLatencyMs ?? 0),
      lastRunAt: r.lastRunAt ?? r.last_run_at ?? null
    }));
  }
  if (!hasDB(env)) return [];

  const { data } = await getDB(env).rpc("get_prompt_run_stats", { p_days: days });
  return (data ?? []).map((r) => ({
    promptKind: r.prompt_kind,
    promptKey: r.prompt_key,
    provider: r.provider,
    modality: r.modality,
    totalRuns: Number(r.total_runs),
    succeeded: Number(r.succeeded),
    failed: Number(r.failed),
    cacheHits: Number(r.cache_hits),
    averageLatencyMs: Number(r.average_latency_ms ?? 0),
    lastRunAt: r.last_run_at
  }));
}

// ── Prompt test results ───────────────────────────────────────────────────────

export async function createPromptTestResult(env, data) {
  const legacyDB = getLegacyTestDB(env);
  if (!hasDB(env) && legacyDB) {
    const cost = serializeCostFields(data.cost);
    const created = await legacyDB.prepare(`
      INSERT INTO prompt_test_results
        (prompt_kind, prompt_key, prompt_template_id, provider, model, modality, status, latency_ms, input_json,
         output_json, prompt_preview, artifact_url, error_text, story_id, story_url, created_by, cost_usd,
         cost_currency, cost_estimated, pricing_source, cost_details_json)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)
    `).bind(
      data.promptKind,
      data.promptKey,
      data.promptTemplateId ?? null,
      data.provider,
      data.model ?? null,
      data.modality,
      data.status,
      data.latencyMs ?? null,
      data.inputJson ?? "{}",
      data.outputJson ?? null,
      data.promptPreview ?? null,
      data.artifactUrl ?? null,
      data.errorText ?? null,
      data.storyId ?? null,
      data.storyUrl ?? data.hnUrl ?? null,
      data.createdBy ?? null,
      cost.costUsd,
      cost.costCurrency,
      cost.costEstimated ?? false ? 1 : 0,
      cost.pricingSource,
      cost.costDetailsJson
    ).first();
    if (!created) return null;
    return {
      ...created,
      costDetailsJson: created.costDetailsJson ?? created.cost_details_json ?? null,
      ...normalizePersistedCostFields({
        cost_usd: created.costUsd ?? created.cost_usd,
        cost_currency: created.costCurrency ?? created.cost_currency,
        cost_estimated: created.costEstimated ?? created.cost_estimated,
        pricing_source: created.pricingSource ?? created.pricing_source,
        cost_details_json: created.costDetailsJson ?? created.cost_details_json ?? null
      })
    };
  }
  if (!hasDB(env)) return null;

  const cost = serializeCostFields(data.cost);

  const { data: created } = await getDB(env)
    .from("prompt_test_results")
    .insert({
      prompt_kind: data.promptKind,
      prompt_key: data.promptKey,
      prompt_template_id: data.promptTemplateId ?? null,
      provider: data.provider,
      model: data.model ?? null,
      modality: data.modality,
      status: data.status,
      latency_ms: data.latencyMs ?? null,
      input: data.inputJson ? (typeof data.inputJson === "string" ? JSON.parse(data.inputJson) : data.inputJson) : {},
      output: data.outputJson ? (typeof data.outputJson === "string" ? JSON.parse(data.outputJson) : data.outputJson) : null,
      prompt_preview: data.promptPreview ?? null,
      artifact_url: data.artifactUrl ?? null,
      error_text: data.errorText ?? null,
      story_id: data.storyId ?? null,
      story_url: data.storyUrl ?? data.hnUrl ?? null,
      created_by: data.createdBy ?? null,
      cost_usd: cost.costUsd,
      cost_currency: cost.costCurrency,
      cost_estimated: cost.costEstimated,
      pricing_source: cost.pricingSource,
      cost_details: cost.costDetailsJson ? JSON.parse(cost.costDetailsJson) : null
    })
    .select()
    .single();

  if (!created) return null;
  return {
    ...created,
    inputJson: JSON.stringify(created.input),
    outputJson: created.output ? JSON.stringify(created.output) : null,
    costDetailsJson: created.cost_details ? JSON.stringify(created.cost_details) : null,
    ...normalizePersistedCostFields(created)
  };
}

export async function listPromptTestResults(env, { promptKind = null, promptKey = null, limit = 20 } = {}) {
  const legacyDB = getLegacyTestDB(env);
  if (!hasDB(env) && legacyDB) {
    const { results } = await legacyDB.prepare("SELECT * FROM prompt_test_results ORDER BY created_at DESC LIMIT ?1")
      .bind(limit)
      .all();
    return (results ?? [])
      .filter((r) => !promptKind || (r.promptKind ?? r.prompt_kind) === promptKind)
      .filter((r) => !promptKey || (r.promptKey ?? r.prompt_key) === promptKey)
      .map((r) => ({
        ...r,
        inputJson: r.inputJson ?? r.input_json ?? "{}",
        outputJson: r.outputJson ?? r.output_json ?? null,
        costDetailsJson: r.costDetailsJson ?? r.cost_details_json ?? null,
        ...normalizePersistedCostFields({
          cost_usd: r.costUsd ?? r.cost_usd,
          cost_currency: r.costCurrency ?? r.cost_currency,
          cost_estimated: r.costEstimated ?? r.cost_estimated,
          pricing_source: r.pricingSource ?? r.pricing_source,
          cost_details_json: r.costDetailsJson ?? r.cost_details_json ?? null
        })
      }));
  }
  if (!hasDB(env)) return [];

  let query = getDB(env)
    .from("prompt_test_results")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (promptKind) query = query.eq("prompt_kind", promptKind);
  if (promptKey) query = query.eq("prompt_key", promptKey);

  const { data } = await query;
  return (data ?? []).map((r) => ({
    ...r,
    inputJson: JSON.stringify(r.input),
    outputJson: r.output ? JSON.stringify(r.output) : null,
    costDetailsJson: r.cost_details ? JSON.stringify(r.cost_details) : null,
    ...normalizePersistedCostFields(r)
  }));
}

export async function selectPromptTestResult(env, id) {
  if (!hasDB(env)) return;

  await getDB(env)
    .from("prompt_test_results")
    .update({ selected: true })
    .eq("id", id);
}

export async function updatePromptTestResultNotes(env, id, notes) {
  if (!hasDB(env)) return;

  await getDB(env)
    .from("prompt_test_results")
    .update({ notes })
    .eq("id", id);
}

// ── RSS sources ───────────────────────────────────────────────────────────────

export async function getRSSSources(env, { category = null, activeOnly = true } = {}) {
  if (!hasDB(env)) return [];

  let query = getDB(env).from("rss_sources").select("*");
  if (activeOnly) query = query.eq("active", true);
  if (category) query = query.eq("category", category);

  const { data } = await query;
  return rows(data);
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
    .upsert({
      story_id: item.storyId,
      source_id: item.sourceId,
      guid: item.guid,
      url: item.url,
      canonical_url: item.canonicalUrl,
      title: item.title,
      description: item.description ?? null,
      author: item.author ?? null,
      published_at: item.publishedAt ?? null
    }, { onConflict: "source_id,guid", ignoreDuplicates: true });

  return !error;
}

export async function getRSSItemByStoryId(env, storyId) {
  if (!hasDB(env)) return null;

  const [itemResult, countResult] = await Promise.all([
    getDB(env)
      .from("rss_items")
      .select("*, rss_sources!inner(name, tier, reliability_score, language)")
      .eq("story_id", storyId)
      .order("rss_sources(tier)", { ascending: true })
      .order("ingested_at", { ascending: true })
      .limit(1)
      .maybeSingle(),
    getDB(env)
      .from("rss_items")
      .select("*", { count: "exact", head: true })
      .eq("story_id", storyId)
  ]);

  const r = itemResult.data;
  if (!r) return null;

  return {
    ...r,
    sourceName: r.rss_sources?.name ?? null,
    sourceTier: r.rss_sources?.tier ?? 2,
    sourceReliability: r.rss_sources?.reliability_score ?? null,
    sourceLanguage: r.rss_sources?.language ?? "en",
    sourceCount: countResult.count ?? 1
  };
}

export async function getPublishedStoryForEnrichment(env, storyId) {
  if (!hasDB(env)) return null;

  const { data: p } = await getDB(env)
    .from("published_feed_entries")
    .select("story_id, source_endpoint, published_at")
    .eq("story_id", storyId)
    .maybeSingle();

  if (!p) return null;

  const { data: c } = await getDB(env)
    .from("story_content")
    .select("extracted_text")
    .eq("story_id", storyId)
    .maybeSingle();

  return {
    storyId: p.story_id,
    sourceEndpoint: p.source_endpoint,
    publishedAt: p.published_at,
    extractedText: c?.extracted_text ?? null
  };
}

export async function updatePublishedFeedEntryEnrichment(env, storyId, fields) {
  if (!hasDB(env)) return;

  await getDB(env)
    .from("published_feed_entries")
    .update({
      topics: fields.topics,
      quality_score: fields.qualityScore,
      novelty_score: fields.noveltyScore,
      language: fields.language,
      entities: fields.entities,
      article_length: fields.articleLength,
      topic_count: fields.topicCount ?? fields.topics?.length ?? null,
      entity_count: fields.entityCount ?? fields.entities?.length ?? null,
      has_author: fields.hasAuthor,
      publisher: fields.publisher,
      publisher_tier: fields.publisherTier,
      source_reliability_score: fields.sourceReliabilityScore
    })
    .eq("story_id", storyId);
}

export async function updatePublishedFeedEntryVelocity(env, storyId, signals) {
  if (!hasDB(env)) return;

  await getDB(env)
    .from("published_feed_entries")
    .update({
      ctr_5m:            signals.ctr5m,
      ctr_30m:           signals.ctr30m,
      ctr_2h:            signals.ctr2h,
      save_rate_2h:      signals.saveRate2h,
      skip_rate_30m:     signals.skipRate30m,
      completion_rate_2h: signals.completionRate2h,
      detail_open_rate_2h: signals.detailOpenRate2h ?? null,
      share_rate_2h: signals.shareRate2h ?? null,
      hide_rate_2h: signals.hideRate2h ?? null,
      ai_action_rate_24h: signals.aiActionRate24h ?? null
    })
    .eq("story_id", storyId);
}

export async function getPublishedEntryForVelocitySync(env, storyId) {
  if (!hasDB(env)) return null;

  const { data } = await getDB(env)
    .from("published_feed_entries")
    .select(`story_id, source_endpoint, headline, published_at, topics, quality_score, novelty_score,
             publisher, language, entities, publisher_tier,
             source_reliability_score, has_author, article_length,
             engagement_count, impression_count, media_type, media_provider,
             media_model, generation_status, generation_latency_ms,
             generation_cost_usd, prompt_template_id, prompt_template_name,
             topic_count, entity_count, detail_open_rate_2h, share_rate_2h,
             hide_rate_2h, ai_action_rate_24h`)
    .eq("story_id", storyId)
    .maybeSingle();

  if (!data) return null;
  return {
    storyId:                data.story_id,
    sourceEndpoint:         data.source_endpoint,
    headline:               data.headline,
    publishedAt:            data.published_at,
    topics:                 data.topics,
    qualityScore:           data.quality_score,
    noveltyScore:           data.novelty_score,
    publisher:              data.publisher,
    language:               data.language,
    entities:               data.entities,
    publisherTier:          data.publisher_tier,
    sourceReliabilityScore: data.source_reliability_score,
    hasAuthor:              data.has_author,
    articleLength:          data.article_length,
    engagementCount:        data.engagement_count,
    impressionCount:        data.impression_count,
    mediaType:              data.media_type,
    mediaProvider:          data.media_provider,
    mediaModel:             data.media_model,
    generationStatus:       data.generation_status,
    generationLatencyMs:    data.generation_latency_ms,
    generationCostUsd:      data.generation_cost_usd,
    promptTemplateId:       data.prompt_template_id,
    promptTemplateName:     data.prompt_template_name,
    topicCount:             data.topic_count,
    entityCount:            data.entity_count,
    detailOpenRate2h:       data.detail_open_rate_2h,
    shareRate2h:            data.share_rate_2h,
    hideRate2h:             data.hide_rate_2h,
    aiActionRate24h:        data.ai_action_rate_24h
  };
}

export async function getStoryVelocityWindow(env, storyId, minutes) {
  if (!hasDB(env)) return { imp: 0, eng: 0, saves: 0, skips: 0, completes: 0 };

  let data = null;
  try {
    const result = await getDB(env).rpc("get_story_velocity_window", {
      p_story_id: storyId,
      p_minutes:  minutes
    });
    data = result.data ?? null;
  } catch {
    const since = new Date(Date.now() - minutes * 60 * 1000).toISOString();
    const { data: rows } = await getDB(env)
      .from("user_events")
      .select("event_type")
      .eq("story_id", storyId)
      .gte("occurred_at", since);

    const counts = { imp: 0, eng: 0, saves: 0, skips: 0, completes: 0, detailOpens: 0, shares: 0, hides: 0, aiActions: 0 };
    for (const row of rows ?? []) {
      const eventType = row.event_type;
      if (eventType === "impression") counts.imp += 1;
      if (["dwell", "complete", "vote", "save", "share", "detail_open", "external_open"].includes(eventType)) counts.eng += 1;
      if (eventType === "save") counts.saves += 1;
      if (eventType === "skip") counts.skips += 1;
      if (eventType === "complete") counts.completes += 1;
      if (eventType === "detail_open") counts.detailOpens += 1;
      if (eventType === "share") counts.shares += 1;
      if (eventType === "hide") counts.hides += 1;
      if (eventType.startsWith("ai_")) counts.aiActions += 1;
    }
    data = [counts];
  }

  const r = data?.[0];
  return {
    imp:      Number(r?.imp      ?? 0),
    eng:      Number(r?.eng      ?? 0),
    saves:    Number(r?.saves    ?? 0),
    skips:    Number(r?.skips    ?? 0),
    completes: Number(r?.completes ?? 0),
    detailOpens: Number(r?.detail_opens ?? r?.detailOpens ?? 0),
    shares: Number(r?.shares ?? 0),
    hides: Number(r?.hides ?? 0),
    aiActions: Number(r?.ai_actions ?? r?.aiActions ?? 0)
  };
}

export async function updateStoryStats(env) {
  if (!hasDB(env)) return 0;
  const { data } = await getDB(env).rpc("update_story_stats");
  return data ?? 0;
}

export async function getActiveStoryIds(env, minutes = 120) {
  if (!hasDB(env)) return [];
  const { data } = await getDB(env).rpc("get_active_story_ids", { p_minutes: minutes });
  return (data ?? []).map((r) => r.story_id);
}

export async function cleanupOldUserEvents(env, days = 30) {
  if (!hasDB(env)) return 0;
  const { data } = await getDB(env).rpc("cleanup_old_user_events", { p_days: days });
  return data ?? 0;
}

export async function getUnenrichedStoryIds(env, limit = 50) {
  if (!hasDB(env)) return [];
  const { data } = await getDB(env)
    .from("published_feed_entries")
    .select("story_id")
    .or("topics.eq.[],topics.is.null")
    .limit(limit);
  return (data ?? []).map((r) => r.story_id);
}

export async function updatePublishedFeedEntryTopics(env, storyId, topics) {
  if (!hasDB(env)) return;
  await getDB(env)
    .from("published_feed_entries")
    .update({ topics: JSON.stringify(topics) })
    .eq("story_id", storyId);
}
