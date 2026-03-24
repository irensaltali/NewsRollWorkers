import { fixtureFeed } from "./fixtures.mjs";
import { normalizePersistedCostFields, serializeCostFields } from "./model-catalog.mjs";
import { AI_PROMPT_KEYS, DEFAULT_AI_PROMPT_CONFIGS, parsePromptSettings } from "./prompt-config.mjs";

function hasDb(env) {
  return Boolean(env?.DB?.prepare);
}

function startOfUtcDay(value = new Date()) {
  const date = new Date(value);
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString();
}

function fixturePublishedFeed(cursor = null, limit = 20) {
  return fixtureFeed
    .slice()
    .sort((left, right) => right.publishSequence - left.publishSequence)
    .filter((item) => cursor == null || item.publishSequence < cursor)
    .slice(0, limit);
}

export async function upsertInstallation(env, installation) {
  if (!hasDb(env)) {
    return installation;
  }

  await env.DB.prepare(
    `
      INSERT INTO installations (id, platform, app_version, push_token, push_enabled, revenuecat_app_user_id, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
      ON CONFLICT(id) DO UPDATE SET
        platform = excluded.platform,
        app_version = excluded.app_version,
        push_token = excluded.push_token,
        push_enabled = excluded.push_enabled,
        revenuecat_app_user_id = excluded.revenuecat_app_user_id,
        updated_at = excluded.updated_at
    `
  )
    .bind(
      installation.id,
      installation.platform,
      installation.appVersion ?? null,
      installation.pushToken ?? null,
      installation.pushEnabled ? 1 : 0,
      installation.revenueCatAppUserId ?? installation.id,
      installation.createdAt,
      installation.updatedAt
    )
    .run();

  return installation;
}

export async function getInstallation(env, installationId) {
  if (!hasDb(env)) {
    return null;
  }

  return env.DB.prepare(
    `
      SELECT
        id AS installationId,
        platform,
        app_version AS appVersion,
        push_token AS pushToken,
        push_enabled AS pushEnabled,
        revenuecat_app_user_id AS revenueCatAppUserId,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM installations
      WHERE id = ?1
    `
  )
    .bind(installationId)
    .first();
}

export async function listPublishedVisualFeed(env, { cursor = null, limit = 20 } = {}) {
  if (!hasDb(env)) {
    return fixturePublishedFeed(cursor, limit);
  }

  const statement = cursor == null
    ? env.DB.prepare(
      `
        SELECT
          p.story_id AS storyId,
          p.publish_sequence AS publishSequence,
          p.source_endpoint AS sourceEndpoint,
          p.published_at AS publishedAt,
          m.media_url AS mediaUrl,
          m.status AS mediaStatus,
          c.ai_headline AS headline
        FROM published_feed_entries p
        JOIN story_media m ON m.story_id = p.story_id
        LEFT JOIN story_content c ON c.story_id = p.story_id
        WHERE m.status = 'ready'
          AND m.media_url IS NOT NULL
        ORDER BY p.publish_sequence DESC
        LIMIT ?1
      `
    ).bind(limit)
    : env.DB.prepare(
      `
        SELECT
          p.story_id AS storyId,
          p.publish_sequence AS publishSequence,
          p.source_endpoint AS sourceEndpoint,
          p.published_at AS publishedAt,
          m.media_url AS mediaUrl,
          m.status AS mediaStatus,
          c.ai_headline AS headline
        FROM published_feed_entries p
        JOIN story_media m ON m.story_id = p.story_id
        LEFT JOIN story_content c ON c.story_id = p.story_id
        WHERE m.status = 'ready'
          AND m.media_url IS NOT NULL
          AND p.publish_sequence < ?1
        ORDER BY p.publish_sequence DESC
        LIMIT ?2
      `
    ).bind(cursor, limit);

  const result = await statement.all();
  return result.results ?? [];
}

export async function getLatestPublishedVisualFeedSnapshot(env, limit = 100) {
  return listPublishedVisualFeed(env, { limit });
}

export async function storeStory(env, storyId, endpoint, rank) {
  if (!hasDb(env)) {
    return;
  }

  await env.DB.prepare(
    `
      INSERT INTO feed_entries (endpoint, story_id, rank, snapshot_at)
      VALUES (?1, ?2, ?3, ?4)
      ON CONFLICT(endpoint, story_id) DO UPDATE SET
        rank = excluded.rank,
        snapshot_at = excluded.snapshot_at
    `
  )
    .bind(endpoint, storyId, rank, new Date().toISOString())
    .run();
}

export async function storeReadableContent(env, payload) {
  if (!hasDb(env)) {
    return;
  }

  await env.DB.prepare(
    `
      INSERT INTO story_content (story_id, source_kind, extracted_text, updated_at)
      VALUES (?1, ?2, ?3, ?4)
      ON CONFLICT(story_id) DO UPDATE SET
        source_kind = excluded.source_kind,
        extracted_text = excluded.extracted_text,
        updated_at = excluded.updated_at
    `
  )
    .bind(
      payload.storyId,
      payload.sourceKind,
      payload.extractedText,
      payload.updatedAt
    )
    .run();
}

export async function getReadableContent(env, storyId) {
  if (!hasDb(env)) {
    return null;
  }

  return env.DB.prepare(
    "SELECT extracted_text AS extractedText FROM story_content WHERE story_id = ?1"
  )
    .bind(storyId)
    .first();
}

export async function getMaxPublishedVisualFeedSequence(env) {
  if (!hasDb(env)) {
    return fixtureFeed.reduce((max, item) => Math.max(max, item.publishSequence ?? 0), 0);
  }

  const row = await env.DB.prepare(
    "SELECT COALESCE(MAX(publish_sequence), 0) AS maxSequence FROM published_feed_entries"
  ).first();
  return Number(row?.maxSequence ?? 0);
}

export async function isStoryPublished(env, storyId) {
  if (!hasDb(env)) {
    return fixtureFeed.some((item) => item.storyId === storyId);
  }

  const row = await env.DB.prepare(
    "SELECT 1 AS published FROM published_feed_entries WHERE story_id = ?1"
  )
    .bind(storyId)
    .first();

  return Boolean(row?.published);
}

export async function publishReadyStory(env, payload) {
  if (!hasDb(env)) {
    return !fixtureFeed.some((item) => item.storyId === payload.storyId);
  }

  const result = await env.DB.prepare(
    `
      INSERT INTO published_feed_entries (story_id, publish_sequence, source_endpoint, published_at)
      VALUES (?1, ?2, ?3, ?4)
      ON CONFLICT(story_id) DO NOTHING
    `
  )
    .bind(
      payload.storyId,
      payload.publishSequence,
      payload.sourceEndpoint,
      payload.publishedAt
    )
    .run();

  return (result.meta?.changes ?? 0) > 0;
}

export async function reserveMediaQueueSlot(env, payload) {
  if (!hasDb(env)) {
    return true;
  }

  const updatedAt = payload.updatedAt ?? new Date().toISOString();
  const dailyLimit = payload.dailyLimit ?? null;
  const result = await env.DB.prepare(
    `
      INSERT INTO story_media (story_id, status, fal_request_id, media_key, media_url, failure_reason, attempts, updated_at, prompt_template_id)
      SELECT ?1, 'queued', NULL, NULL, NULL, NULL, 0, ?2, NULL
      WHERE NOT EXISTS (
        SELECT 1
        FROM story_media
        WHERE story_id = ?1
      )
      AND (
        ?3 IS NULL OR (
          SELECT COUNT(*)
          FROM story_media
          WHERE updated_at >= ?4
        ) < ?3
      )
    `
  )
    .bind(payload.storyId, updatedAt, dailyLimit, startOfUtcDay(updatedAt))
    .run();

  return (result.meta?.changes ?? 0) > 0;
}

export async function batchInsertEvents(env, installationId, events) {
  if (!hasDb(env) || events.length === 0) {
    return { stored: 0 };
  }

  const statements = events.map((event) =>
    env.DB.prepare(
      `INSERT INTO user_events (installation_id, story_id, event_type, event_value, created_at)
       VALUES (?1, ?2, ?3, ?4, datetime('now'))`
    ).bind(
      installationId,
      event.storyId,
      event.eventType,
      event.eventValue ? JSON.stringify(event.eventValue) : null
    )
  );

  const results = await env.DB.batch(statements);
  const stored = results.reduce((sum, r) => sum + (r.meta?.changes ?? 0), 0);
  return { stored };
}

export async function getUserProfile(env, installationId) {
  if (!hasDb(env)) return null;

  return env.DB.prepare(
    `SELECT installation_id AS installationId, topic_scores AS topicScores,
            endpoint_scores AS endpointScores, media_pref AS mediaPref,
            total_impressions AS totalImpressions, total_engagements AS totalEngagements,
            updated_at AS updatedAt
     FROM user_profiles WHERE installation_id = ?1`
  ).bind(installationId).first();
}

export async function upsertUserProfile(env, installationId, profile) {
  if (!hasDb(env)) return;

  await env.DB.prepare(
    `INSERT INTO user_profiles (installation_id, topic_scores, endpoint_scores, media_pref, total_impressions, total_engagements, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now'))
     ON CONFLICT(installation_id) DO UPDATE SET
       topic_scores = excluded.topic_scores,
       endpoint_scores = excluded.endpoint_scores,
       media_pref = excluded.media_pref,
       total_impressions = excluded.total_impressions,
       total_engagements = excluded.total_engagements,
       updated_at = excluded.updated_at`
  ).bind(
    installationId,
    JSON.stringify(profile.topicScores ?? {}),
    JSON.stringify(profile.endpointScores ?? {}),
    JSON.stringify(profile.mediaPref ?? {}),
    profile.totalImpressions ?? 0,
    profile.totalEngagements ?? 0
  ).run();
}

export async function getRecommendationCandidates(env, limit = 200) {
  if (!hasDb(env)) return [];

  const result = await env.DB.prepare(
    `SELECT p.story_id AS storyId, p.publish_sequence AS publishSequence,
            p.source_endpoint AS sourceEndpoint, p.published_at AS publishedAt,
            p.topics, p.quality_score AS qualityScore, p.novelty_score AS noveltyScore,
            p.engagement_count AS engagementCount, p.impression_count AS impressionCount,
            m.media_url AS mediaUrl, m.status AS mediaStatus,
            c.ai_headline AS headline
     FROM published_feed_entries p
     JOIN story_media m ON m.story_id = p.story_id
     LEFT JOIN story_content c ON c.story_id = p.story_id
     WHERE m.status = 'ready'
       AND m.media_url IS NOT NULL
       AND p.topics IS NOT NULL
       AND p.topics != '[]'
     ORDER BY p.publish_sequence DESC
     LIMIT ?1`
  ).bind(limit).all();

  return result.results ?? [];
}

export async function getSeenStoryIds(env, installationId, days = 7) {
  if (!hasDb(env)) return [];

  const result = await env.DB.prepare(
    `SELECT DISTINCT story_id AS storyId FROM user_events
     WHERE installation_id = ?1
       AND event_type = 'impression'
       AND created_at > datetime('now', '-' || ?2 || ' days')`
  ).bind(installationId, days).all();

  return (result.results ?? []).map((r) => r.storyId);
}

export async function getCachedAIResult(env, cacheKey) {
  if (!hasDb(env)) {
    return null;
  }

  const row = await env.DB.prepare(
    `SELECT result_text AS resultText, result_type AS resultType, model, created_at AS createdAt
     FROM ai_results_cache
     WHERE cache_key = ?1
       AND (expires_at IS NULL OR expires_at > datetime('now'))`
  )
    .bind(cacheKey)
    .first();

  return row ?? null;
}

export async function hasAIRequestReceipt(env, payload) {
  if (!hasDb(env)) {
    return false;
  }

  const row = await env.DB.prepare(
    `SELECT 1 AS ok
     FROM ai_request_receipts
     WHERE subscriber_id = ?1
       AND action = ?2
       AND story_id = ?3
       AND target_language IS ?4
       AND content_hash = ?5`
  )
    .bind(
      payload.subscriberId,
      payload.action,
      payload.storyId,
      payload.targetLanguage ?? null,
      payload.contentHash
    )
    .first();

  return Boolean(row?.ok);
}

export async function storeAIRequestReceipt(env, payload) {
  if (!hasDb(env)) {
    return;
  }

  await env.DB.prepare(
    `INSERT OR IGNORE INTO ai_request_receipts (
        subscriber_id,
        action,
        story_id,
        target_language,
        content_hash,
        created_at
     )
     VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))`
  )
    .bind(
      payload.subscriberId,
      payload.action,
      payload.storyId,
      payload.targetLanguage ?? null,
      payload.contentHash
    )
    .run();
}

export async function storeCachedAIResult(env, payload) {
  if (!hasDb(env)) {
    return;
  }

  await env.DB.prepare(
    `INSERT INTO ai_results_cache (cache_key, result_type, story_id, result_text, model, created_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'), ?6)
     ON CONFLICT(cache_key) DO UPDATE SET
       result_text = excluded.result_text,
       model = excluded.model,
       created_at = excluded.created_at,
       expires_at = excluded.expires_at`
  )
    .bind(
      payload.cacheKey,
      payload.resultType,
      payload.storyId ?? null,
      payload.resultText,
      payload.model ?? null,
      payload.expiresAt ?? null
    )
    .run();
}

export async function releaseMediaQueueSlot(env, storyId) {
  if (!hasDb(env)) {
    return;
  }

  await env.DB.prepare(
    `
      DELETE FROM story_media
      WHERE story_id = ?1
        AND status = 'queued'
        AND attempts = 0
        AND prompt_template_id IS NULL
    `
  )
    .bind(storyId)
    .run();
}

export async function storeHeadline(env, storyId, headline, headlinePrompt) {
  if (!hasDb(env)) {
    return;
  }

  await env.DB.prepare(
    "UPDATE story_content SET ai_headline = ?1, headline_prompt = ?2 WHERE story_id = ?3"
  )
    .bind(headline, headlinePrompt ?? null, storyId)
    .run();
}

export async function getPromptTemplateStats(env, days = 30) {
  if (!hasDb(env)) {
    return [];
  }

  const result = await env.DB.prepare(
    `
      SELECT
        pt.id AS templateId,
        pt.name AS templateName,
        COUNT(*) AS totalGenerated,
        SUM(CASE WHEN m.status = 'ready' THEN 1 ELSE 0 END) AS succeeded,
        SUM(CASE WHEN m.status = 'failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN m.status = 'dead_letter' THEN 1 ELSE 0 END) AS deadLettered,
        COALESCE(SUM(p.engagement_count), 0) AS totalEngagements,
        COALESCE(SUM(p.impression_count), 0) AS totalImpressions,
        CASE WHEN SUM(p.impression_count) > 0
          THEN ROUND(CAST(SUM(p.engagement_count) AS REAL) / SUM(p.impression_count), 4)
          ELSE 0
        END AS engagementRate
      FROM story_media m
      JOIN prompt_templates pt ON pt.id = m.prompt_template_id
      LEFT JOIN published_feed_entries p ON p.story_id = m.story_id
      WHERE m.updated_at >= datetime('now', '-' || ?1 || ' days')
      GROUP BY pt.id, pt.name
      ORDER BY totalGenerated DESC
    `
  )
    .bind(days)
    .all();

  return result.results ?? [];
}

export async function cleanupStaleMedia(env, days = 7) {
  if (!hasDb(env)) {
    return 0;
  }

  const result = await env.DB.prepare(
    `
      DELETE FROM story_media
      WHERE status IN ('failed', 'dead_letter')
        AND updated_at < datetime('now', '-' || ?1 || ' days')
        AND story_id NOT IN (SELECT story_id FROM published_feed_entries)
    `
  )
    .bind(days)
    .run();

  return result.meta?.changes ?? 0;
}

export async function upsertMedia(env, payload) {
  if (!hasDb(env)) {
    return;
  }

  await env.DB.prepare(
    `
      INSERT INTO story_media (story_id, status, fal_request_id, media_key, media_url, failure_reason, attempts, updated_at, prompt_template_id, image_prompt)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
      ON CONFLICT(story_id) DO UPDATE SET
        status = excluded.status,
        fal_request_id = excluded.fal_request_id,
        media_key = excluded.media_key,
        media_url = excluded.media_url,
        failure_reason = excluded.failure_reason,
        attempts = excluded.attempts,
        updated_at = excluded.updated_at,
        prompt_template_id = excluded.prompt_template_id,
        image_prompt = excluded.image_prompt
    `
  )
    .bind(
      payload.storyId,
      payload.status,
      payload.falRequestId ?? null,
      payload.mediaKey ?? null,
      payload.mediaUrl ?? null,
      payload.failureReason ?? null,
      payload.attempts ?? 0,
      payload.updatedAt,
      payload.promptTemplateId ?? null,
      payload.imagePrompt ?? null
    )
    .run();
}

function normalizePromptConfigRow(row) {
  if (!row) {
    return null;
  }

  return {
    key: row.key,
    name: row.name,
    provider: row.provider,
    model: row.model,
    maxCompletionTokens: Number(row.maxCompletionTokens ?? row.max_completion_tokens ?? 0),
    systemPrompt: row.systemPrompt ?? row.system_prompt ?? "",
    userPromptTemplate: row.userPromptTemplate ?? row.user_prompt_template ?? "",
    settings: parsePromptSettings(row.settings ?? row.settingsJson ?? row.settings_json, {}),
    active: Number(row.active ?? 1),
    createdAt: row.createdAt ?? row.created_at ?? null,
    updatedAt: row.updatedAt ?? row.updated_at ?? null
  };
}

function normalizePromptTemplateRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id == null ? null : Number(row.id),
    name: row.name,
    description: row.description ?? null,
    templateText: row.templateText ?? row.template_text ?? "",
    active: Number(row.active ?? 1),
    modality: row.modality ?? "image",
    provider: row.provider ?? "fal",
    model: row.model ?? null,
    settings: parsePromptSettings(row.settings ?? row.settingsJson ?? row.settings_json, {}),
    createdBy: row.createdBy ?? row.created_by ?? null,
    createdAt: row.createdAt ?? row.created_at ?? null,
    updatedAt: row.updatedAt ?? row.updated_at ?? null
  };
}

function fallbackPromptConfigRows() {
  return AI_PROMPT_KEYS.map((key) => {
    const config = DEFAULT_AI_PROMPT_CONFIGS[key];
    return {
      ...config,
      settings: parsePromptSettings(config.settings, {})
    };
  });
}

export async function listAIPromptConfigs(env) {
  if (!hasDb(env)) {
    return fallbackPromptConfigRows();
  }

  const result = await env.DB.prepare(
    `
      SELECT
        key,
        name,
        provider,
        model,
        max_completion_tokens AS maxCompletionTokens,
        system_prompt AS systemPrompt,
        user_prompt_template AS userPromptTemplate,
        settings_json AS settingsJson,
        active,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM ai_prompt_configs
      ORDER BY key ASC
    `
  ).all();

  const byKey = new Map((result.results ?? []).map((row) => {
    const normalized = normalizePromptConfigRow(row);
    return [normalized.key, normalized];
  }));

  return AI_PROMPT_KEYS.map((key) => byKey.get(key) ?? fallbackPromptConfigRows().find((item) => item.key === key));
}

export async function getAIPromptConfig(env, key) {
  if (!hasDb(env)) {
    return fallbackPromptConfigRows().find((item) => item.key === key) ?? null;
  }

  const row = await env.DB.prepare(
    `
      SELECT
        key,
        name,
        provider,
        model,
        max_completion_tokens AS maxCompletionTokens,
        system_prompt AS systemPrompt,
        user_prompt_template AS userPromptTemplate,
        settings_json AS settingsJson,
        active,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM ai_prompt_configs
      WHERE key = ?1
    `
  )
    .bind(key)
    .first();

  return normalizePromptConfigRow(row) ?? fallbackPromptConfigRows().find((item) => item.key === key) ?? null;
}

export async function upsertAIPromptConfig(env, payload) {
  if (!hasDb(env)) {
    return normalizePromptConfigRow(payload);
  }

  await env.DB.prepare(
    `
      INSERT INTO ai_prompt_configs (
        key,
        name,
        provider,
        model,
        max_completion_tokens,
        system_prompt,
        user_prompt_template,
        settings_json,
        active,
        updated_at
      )
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
      ON CONFLICT(key) DO UPDATE SET
        name = excluded.name,
        provider = excluded.provider,
        model = excluded.model,
        max_completion_tokens = excluded.max_completion_tokens,
        system_prompt = excluded.system_prompt,
        user_prompt_template = excluded.user_prompt_template,
        settings_json = excluded.settings_json,
        active = excluded.active,
        updated_at = excluded.updated_at
    `
  )
    .bind(
      payload.key,
      payload.name,
      payload.provider,
      payload.model,
      payload.maxCompletionTokens,
      payload.systemPrompt,
      payload.userPromptTemplate,
      JSON.stringify(payload.settings ?? {}),
      payload.active ? 1 : 0,
      payload.updatedAt ?? new Date().toISOString()
    )
    .run();

  return getAIPromptConfig(env, payload.key);
}

export async function listPromptTemplates(env, { modality = null } = {}) {
  if (!hasDb(env)) {
    return [];
  }

  const statement = modality
    ? env.DB.prepare(
      `
        SELECT
          id,
          name,
          description,
          template_text AS templateText,
          active,
          modality,
          provider,
          model,
          settings_json AS settingsJson,
          created_by AS createdBy,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM prompt_templates
        WHERE modality = ?1
        ORDER BY active DESC, updated_at DESC, id DESC
      `
    ).bind(modality)
    : env.DB.prepare(
      `
        SELECT
          id,
          name,
          description,
          template_text AS templateText,
          active,
          modality,
          provider,
          model,
          settings_json AS settingsJson,
          created_by AS createdBy,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM prompt_templates
        ORDER BY modality ASC, active DESC, updated_at DESC, id DESC
      `
    );

  const result = await statement.all();
  return (result.results ?? []).map(normalizePromptTemplateRow);
}

export async function getPromptTemplateById(env, templateId) {
  if (!hasDb(env)) {
    return null;
  }

  const row = await env.DB.prepare(
    `
      SELECT
        id,
        name,
        description,
        template_text AS templateText,
        active,
        modality,
        provider,
        model,
        settings_json AS settingsJson,
        created_by AS createdBy,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM prompt_templates
      WHERE id = ?1
    `
  )
    .bind(templateId)
    .first();

  return normalizePromptTemplateRow(row);
}

export async function upsertPromptTemplate(env, payload) {
  if (!hasDb(env)) {
    return normalizePromptTemplateRow(payload);
  }

  if (payload.id) {
    await env.DB.prepare(
      `
        UPDATE prompt_templates
        SET
          name = ?2,
          description = ?3,
          template_text = ?4,
          active = ?5,
          modality = ?6,
          provider = ?7,
          model = ?8,
          settings_json = ?9,
          created_by = COALESCE(?10, created_by),
          updated_at = ?11
        WHERE id = ?1
      `
    )
      .bind(
        payload.id,
        payload.name,
        payload.description ?? null,
        payload.templateText,
        payload.active ? 1 : 0,
        payload.modality ?? "image",
        payload.provider ?? "fal",
        payload.model ?? null,
        JSON.stringify(payload.settings ?? {}),
        payload.createdBy ?? null,
        payload.updatedAt ?? new Date().toISOString()
      )
      .run();
    return getPromptTemplateById(env, payload.id);
  }

  const result = await env.DB.prepare(
    `
      INSERT INTO prompt_templates (
        name,
        description,
        template_text,
        active,
        modality,
        provider,
        model,
        settings_json,
        created_by,
        created_at,
        updated_at
      )
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
    `
  )
    .bind(
      payload.name,
      payload.description ?? null,
      payload.templateText,
      payload.active ? 1 : 0,
      payload.modality ?? "image",
      payload.provider ?? "fal",
      payload.model ?? null,
      JSON.stringify(payload.settings ?? {}),
      payload.createdBy ?? null,
      payload.createdAt ?? new Date().toISOString(),
      payload.updatedAt ?? new Date().toISOString()
    )
    .run();

  return getPromptTemplateById(env, result.meta?.last_row_id ?? null);
}

export async function getActivePromptTemplate(env, { modality = "image", provider = null } = {}) {
  if (!hasDb(env)) {
    return null;
  }

  const statement = provider
    ? env.DB.prepare(
      `
        SELECT
          id,
          name,
          description,
          template_text AS templateText,
          active,
          modality,
          provider,
          model,
          settings_json AS settingsJson,
          created_by AS createdBy,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM prompt_templates
        WHERE active = 1
          AND modality = ?1
          AND provider = ?2
        ORDER BY updated_at DESC, id DESC
        LIMIT 1
      `
    ).bind(modality, provider)
    : env.DB.prepare(
      `
        SELECT
          id,
          name,
          description,
          template_text AS templateText,
          active,
          modality,
          provider,
          model,
          settings_json AS settingsJson,
          created_by AS createdBy,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM prompt_templates
        WHERE active = 1
          AND modality = ?1
        ORDER BY updated_at DESC, id DESC
        LIMIT 1
      `
    ).bind(modality);

  const row = await statement.first();
  return normalizePromptTemplateRow(row);
}

export async function getRandomActivePromptTemplate(env, { modality = "image", provider = null } = {}) {
  if (!hasDb(env)) {
    return null;
  }

  const statement = provider
    ? env.DB.prepare(
      `
        SELECT
          id,
          name,
          description,
          template_text AS templateText,
          active,
          modality,
          provider,
          model,
          settings_json AS settingsJson,
          created_by AS createdBy,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM prompt_templates
        WHERE active = 1
          AND modality = ?1
          AND provider = ?2
        ORDER BY RANDOM()
        LIMIT 1
      `
    ).bind(modality, provider)
    : env.DB.prepare(
      `
        SELECT
          id,
          name,
          description,
          template_text AS templateText,
          active,
          modality,
          provider,
          model,
          settings_json AS settingsJson,
          created_by AS createdBy,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM prompt_templates
        WHERE active = 1
          AND modality = ?1
        ORDER BY RANDOM()
        LIMIT 1
      `
    ).bind(modality);

  const row = await statement.first();
  return normalizePromptTemplateRow(row);
}

export async function getAdminUserByUsername(env, username) {
  if (!hasDb(env)) {
    return null;
  }

  return env.DB.prepare(
    `
      SELECT
        id,
        username,
        password_salt AS passwordSalt,
        password_hash AS passwordHash,
        active,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM admin_users
      WHERE username = ?1
    `
  )
    .bind(username)
    .first();
}

export async function upsertAdminUser(env, payload) {
  if (!hasDb(env)) {
    return null;
  }

  await env.DB.prepare(
    `
      INSERT INTO admin_users (username, password_salt, password_hash, active, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5)
      ON CONFLICT(username) DO UPDATE SET
        password_salt = excluded.password_salt,
        password_hash = excluded.password_hash,
        active = excluded.active,
        updated_at = excluded.updated_at
    `
  )
    .bind(
      payload.username,
      payload.passwordSalt,
      payload.passwordHash,
      payload.active ? 1 : 0,
      payload.updatedAt ?? new Date().toISOString()
    )
    .run();

  return getAdminUserByUsername(env, payload.username);
}

export async function createAdminSession(env, payload) {
  if (!hasDb(env)) {
    return null;
  }

  await env.DB.prepare(
    `
      INSERT INTO admin_sessions (
        id,
        user_id,
        session_hash,
        access_email,
        access_subject,
        created_at,
        expires_at,
        last_seen_at
      )
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
    `
  )
    .bind(
      payload.id,
      payload.userId,
      payload.sessionHash,
      payload.accessEmail ?? null,
      payload.accessSubject ?? null,
      payload.createdAt ?? new Date().toISOString(),
      payload.expiresAt,
      payload.lastSeenAt ?? new Date().toISOString()
    )
    .run();
}

export async function getAdminSessionByHash(env, sessionHash) {
  if (!hasDb(env)) {
    return null;
  }

  return env.DB.prepare(
    `
      SELECT
        s.id,
        s.user_id AS userId,
        s.session_hash AS sessionHash,
        s.access_email AS accessEmail,
        s.access_subject AS accessSubject,
        s.created_at AS createdAt,
        s.expires_at AS expiresAt,
        s.last_seen_at AS lastSeenAt,
        u.username AS username,
        u.active AS userActive
      FROM admin_sessions s
      JOIN admin_users u ON u.id = s.user_id
      WHERE s.session_hash = ?1
    `
  )
    .bind(sessionHash)
    .first();
}

export async function touchAdminSession(env, sessionHash) {
  if (!hasDb(env)) {
    return;
  }

  await env.DB.prepare(
    `
      UPDATE admin_sessions
      SET last_seen_at = ?2
      WHERE session_hash = ?1
    `
  )
    .bind(sessionHash, new Date().toISOString())
    .run();
}

export async function deleteAdminSession(env, sessionHash) {
  if (!hasDb(env)) {
    return;
  }

  await env.DB.prepare(
    "DELETE FROM admin_sessions WHERE session_hash = ?1"
  )
    .bind(sessionHash)
    .run();
}

export async function createAdminAuditLog(env, payload) {
  if (!hasDb(env)) {
    return;
  }

  await env.DB.prepare(
    `
      INSERT INTO admin_audit_log (
        user_id,
        username,
        action,
        target_type,
        target_id,
        details_json,
        created_at
      )
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
    `
  )
    .bind(
      payload.userId ?? null,
      payload.username ?? null,
      payload.action,
      payload.targetType ?? null,
      payload.targetId ?? null,
      payload.detailsJson ?? null,
      payload.createdAt ?? new Date().toISOString()
    )
    .run();
}

export async function createPromptRunEvent(env, payload) {
  if (!hasDb(env)) {
    return;
  }

  const cost = serializeCostFields(payload.cost);

  await env.DB.prepare(
    `
      INSERT INTO prompt_run_events (
        source,
        prompt_kind,
        prompt_key,
        prompt_template_id,
        provider,
        model,
        modality,
        status,
        latency_ms,
        cache_hit,
        request_excerpt,
        response_excerpt,
        artifact_url,
        error_text,
        story_id,
        cost_usd,
        cost_currency,
        cost_estimated,
        pricing_source,
        cost_details_json,
        created_at
      )
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)
    `
  )
    .bind(
      payload.source,
      payload.promptKind,
      payload.promptKey,
      payload.promptTemplateId ?? null,
      payload.provider,
      payload.model ?? null,
      payload.modality,
      payload.status,
      payload.latencyMs ?? null,
      payload.cacheHit ? 1 : 0,
      payload.requestExcerpt ?? null,
      payload.responseExcerpt ?? null,
      payload.artifactUrl ?? null,
      payload.errorText ?? null,
      payload.storyId ?? null,
      cost.costUsd,
      cost.costCurrency,
      cost.costEstimated,
      cost.pricingSource,
      cost.costDetailsJson,
      payload.createdAt ?? new Date().toISOString()
    )
    .run();
}

export async function listPromptRunEvents(env, { days = 30, limit = 50 } = {}) {
  if (!hasDb(env)) {
    return [];
  }

  const result = await env.DB.prepare(
    `
      SELECT
        id,
        source,
        prompt_kind AS promptKind,
        prompt_key AS promptKey,
        prompt_template_id AS promptTemplateId,
        provider,
        model,
        modality,
        status,
        latency_ms AS latencyMs,
        cache_hit AS cacheHit,
        request_excerpt AS requestExcerpt,
        response_excerpt AS responseExcerpt,
        artifact_url AS artifactUrl,
        error_text AS errorText,
        story_id AS storyId,
        cost_usd AS costUsd,
        cost_currency AS costCurrency,
        cost_estimated AS costEstimated,
        pricing_source AS pricingSource,
        cost_details_json AS costDetailsJson,
        created_at AS createdAt
      FROM prompt_run_events
      WHERE created_at >= datetime('now', '-' || ?1 || ' days')
      ORDER BY created_at DESC
      LIMIT ?2
    `
  )
    .bind(days, limit)
    .all();

  return (result.results ?? []).map((row) => ({
    ...row,
    ...normalizePersistedCostFields(row)
  }));
}

export async function getPromptRunOverview(env, { days = 30 } = {}) {
  if (!hasDb(env)) {
    return {
      totalRuns: 0,
      succeeded: 0,
      failed: 0,
      cacheHits: 0,
      averageLatencyMs: 0
    };
  }

  const row = await env.DB.prepare(
    `
      SELECT
        COUNT(*) AS totalRuns,
        SUM(CASE WHEN status IN ('completed', 'ready', 'cached') THEN 1 ELSE 0 END) AS succeeded,
        SUM(CASE WHEN status IN ('failed', 'dead_letter') THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN cache_hit = 1 THEN 1 ELSE 0 END) AS cacheHits,
        ROUND(AVG(CASE WHEN latency_ms IS NOT NULL THEN latency_ms END), 0) AS averageLatencyMs
      FROM prompt_run_events
      WHERE created_at >= datetime('now', '-' || ?1 || ' days')
    `
  )
    .bind(days)
    .first();

  return {
    totalRuns: Number(row?.totalRuns ?? 0),
    succeeded: Number(row?.succeeded ?? 0),
    failed: Number(row?.failed ?? 0),
    cacheHits: Number(row?.cacheHits ?? 0),
    averageLatencyMs: Number(row?.averageLatencyMs ?? 0)
  };
}

export async function getPromptRunStats(env, { days = 30 } = {}) {
  if (!hasDb(env)) {
    return [];
  }

  const result = await env.DB.prepare(
    `
      SELECT
        prompt_kind AS promptKind,
        prompt_key AS promptKey,
        provider,
        modality,
        COUNT(*) AS totalRuns,
        SUM(CASE WHEN status IN ('completed', 'ready', 'cached') THEN 1 ELSE 0 END) AS succeeded,
        SUM(CASE WHEN status IN ('failed', 'dead_letter') THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN cache_hit = 1 THEN 1 ELSE 0 END) AS cacheHits,
        ROUND(AVG(CASE WHEN latency_ms IS NOT NULL THEN latency_ms END), 0) AS averageLatencyMs,
        MAX(created_at) AS lastRunAt
      FROM prompt_run_events
      WHERE created_at >= datetime('now', '-' || ?1 || ' days')
      GROUP BY prompt_kind, prompt_key, provider, modality
      ORDER BY totalRuns DESC, lastRunAt DESC
    `
  )
    .bind(days)
    .all();

  return result.results ?? [];
}

export async function createPromptTestResult(env, data) {
  if (!hasDb(env)) {
    return null;
  }

  const cost = serializeCostFields(data.cost);

  const result = await env.DB.prepare(
    `
      INSERT INTO prompt_test_results
        (prompt_kind, prompt_key, prompt_template_id, provider, model, modality, status,
         latency_ms, input_json, output_json, prompt_preview, artifact_url, error_text,
         story_id, hn_url, created_by, cost_usd, cost_currency, cost_estimated,
         pricing_source, cost_details_json)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)
      RETURNING *
    `
  )
    .bind(
      data.promptKind,
      data.promptKey,
      data.promptTemplateId ?? null,
      data.provider,
      data.model ?? null,
      data.modality,
      data.status,
      data.latencyMs ?? null,
      data.inputJson,
      data.outputJson ?? null,
      data.promptPreview ?? null,
      data.artifactUrl ?? null,
      data.errorText ?? null,
      data.storyId ?? null,
      data.hnUrl ?? null,
      data.createdBy ?? null,
      cost.costUsd,
      cost.costCurrency,
      cost.costEstimated,
      cost.pricingSource,
      cost.costDetailsJson
    )
    .first();

  return result ? {
    ...result,
    ...normalizePersistedCostFields(result)
  } : null;
}

export async function listPromptTestResults(env, { promptKind = null, promptKey = null, limit = 20 } = {}) {
  if (!hasDb(env)) {
    return [];
  }

  const conditions = [];
  const binds = [];
  let idx = 1;

  if (promptKind) {
    conditions.push(`prompt_kind = ?${idx++}`);
    binds.push(promptKind);
  }
  if (promptKey) {
    conditions.push(`prompt_key = ?${idx++}`);
    binds.push(promptKey);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const result = await env.DB.prepare(
    `
      SELECT
        id, prompt_kind AS promptKind, prompt_key AS promptKey,
        prompt_template_id AS promptTemplateId, provider, model, modality, status,
        latency_ms AS latencyMs, input_json AS inputJson, output_json AS outputJson,
        prompt_preview AS promptPreview, artifact_url AS artifactUrl,
        error_text AS errorText, story_id AS storyId, hn_url AS hnUrl,
        selected, notes, created_by AS createdBy, created_at AS createdAt,
        cost_usd AS costUsd, cost_currency AS costCurrency, cost_estimated AS costEstimated,
        pricing_source AS pricingSource, cost_details_json AS costDetailsJson
      FROM prompt_test_results
      ${where}
      ORDER BY created_at DESC
      LIMIT ?${idx}
    `
  )
    .bind(...binds, limit)
    .all();

  return (result.results ?? []).map((row) => ({
    ...row,
    ...normalizePersistedCostFields(row)
  }));
}

export async function selectPromptTestResult(env, id, promptKind, promptKey) {
  if (!hasDb(env)) {
    return false;
  }

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE prompt_test_results SET selected = 0 WHERE prompt_kind = ?1 AND prompt_key = ?2`
    ).bind(promptKind, promptKey),
    env.DB.prepare(
      `UPDATE prompt_test_results SET selected = 1 WHERE id = ?1`
    ).bind(id)
  ]);

  return true;
}

export async function updatePromptTestResultNotes(env, id, notes) {
  if (!hasDb(env)) {
    return false;
  }

  await env.DB.prepare(
    `UPDATE prompt_test_results SET notes = ?1 WHERE id = ?2`
  )
    .bind(notes, id)
    .run();

  return true;
}
