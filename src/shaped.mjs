import * as log from "./log.mjs";

const SHAPED_BASE_URL = "https://api.shaped.ai";
const DEFAULT_ENGINE_NAME = "newsroll_visual_v1";
const DEFAULT_ITEMS_TABLE = "newsroll_items";
const DEFAULT_INTERACTIONS_TABLE = "newsroll_interactions";

function isEnabled(env) {
  return typeof env?.SHAPED_API_KEY === "string" && env.SHAPED_API_KEY.length > 0;
}

function shapedHeaders(env) {
  return {
    "x-api-key": env.SHAPED_API_KEY
  };
}

function engineName(env) {
  return env?.SHAPED_ENGINE_NAME ?? DEFAULT_ENGINE_NAME;
}

function itemsTable(env) {
  return env?.SHAPED_ITEMS_TABLE ?? DEFAULT_ITEMS_TABLE;
}

function interactionsTable(env) {
  return env?.SHAPED_INTERACTIONS_TABLE ?? DEFAULT_INTERACTIONS_TABLE;
}

function scoreExpression(env) {
  return env?.SHAPED_SCORE_EXPRESSION ?? "click_through_rate";
}

function escapeShapedString(value) {
  return String(value).replace(/'/g, "''");
}

function buildRankQuery(env, limit) {
  const valueModel = escapeShapedString(scoreExpression(env));
  return [
    "SELECT *",
    "FROM ids($candidate_item_ids)",
    `ORDER BY score(expression='${valueModel}', input_user_id='$user_id')`,
    `LIMIT ${Math.max(1, limit)}`
  ].join("\n");
}

function buildInsertPayload(rows) {
  return JSON.stringify({ data: rows });
}

/**
 * Upsert a single article item into the Shaped catalog.
 * Fire-and-forget safe — never throws to caller.
 */
export async function upsertItem(env, item) {
  if (!isEnabled(env)) return { ok: true };
  try {
    const shapedItem = {
      item_id: String(item.storyId),
      created_at: item.publishedAt ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
      headline: item.headline ?? null,
      publisher: item.publisher ?? null,
      source_endpoint: item.sourceEndpoint ?? null,
      topics_text: Array.isArray(item.topics) ? item.topics.join(" ") : item.topics ?? null,
      entities_text: Array.isArray(item.entities)
        ? item.entities.map((entity) => entity?.name ?? entity).filter(Boolean).join(" ")
        : item.entities ?? null,
      language: item.language ?? "en",
      quality_score: item.qualityScore ?? 0.5,
      novelty_score: item.noveltyScore ?? 0.5,
      publisher_tier: item.publisherTier ?? 2,
      source_reliability_score: item.sourceReliabilityScore ?? 0.5,
      media_url: item.mediaUrl ?? null,
      media_type: item.mediaType ?? null,
      media_provider: item.mediaProvider ?? null,
      media_model: item.mediaModel ?? null,
      generation_status: item.generationStatus ?? null,
      prompt_template_id: item.promptTemplateId ?? null,
      prompt_template_name: item.promptTemplateName ?? null,
      article_length: item.articleLength ?? null,
      has_author: Boolean(item.hasAuthor),
      topic_count: item.topicCount ?? (Array.isArray(item.topics) ? item.topics.length : null),
      entity_count: item.entityCount ?? (Array.isArray(item.entities) ? item.entities.length : null),
      duplicate_cluster_size: item.duplicateClusterSize ?? 1,
      ctr_5m: item.ctr5m ?? 0.0,
      ctr_30m: item.ctr30m ?? 0.0,
      ctr_2h: item.ctr2h ?? 0.0,
      save_rate_2h: item.saveRate2h ?? 0.0,
      skip_rate_30m: item.skipRate30m ?? 0.0,
      completion_rate_2h: item.completionRate2h ?? 0.0,
      detail_open_rate_2h: item.detailOpenRate2h ?? 0.0,
      share_rate_2h: item.shareRate2h ?? 0.0,
      hide_rate_2h: item.hideRate2h ?? 0.0,
      ai_action_rate_24h: item.aiActionRate24h ?? 0.0
    };

    const url = `${SHAPED_BASE_URL}/v2/tables/${itemsTable(env)}/insert`;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        ...shapedHeaders(env),
        "Content-Type": "application/json"
      },
      body: buildInsertPayload([shapedItem])
    });

    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      log.warn({ event: "shaped_upsert_fail", storyId: item.storyId, httpStatus: resp.status, detail: detail.slice(0, 200) });
      return { ok: false, reason: `http_${resp.status}` };
    }

    return { ok: true };
  } catch (err) {
    log.warn({ event: "shaped_upsert_error", storyId: item.storyId, ...log.fmtError(err) });
    return { ok: false, reason: err.message };
  }
}

/**
 * Forward a batch of user interaction events to Shaped.
 * Fire-and-forget safe — never throws to caller.
 */
export async function trackEvents(env, userId, events) {
  if (!isEnabled(env) || !events?.length) return { ok: true };
  try {
    const interactions = events
      .map((e) => ({
        event_id: e.eventId ?? crypto.randomUUID(),
        user_id: userId,
        item_id: String(e.storyId),
        created_at: e.occurredAt ?? new Date().toISOString(),
        event_type: e.eventType,
        label: e.label ?? null,
        session_id: e.sessionId ?? null,
        surface: e.surface ?? "unknown",
        position: e.position ?? null,
        feed_mode: e.feedMode ?? null,
        dwell_ms: e.dwellMs ?? null,
        media_type: e.mediaType ?? null,
        source_endpoint: e.sourceEndpoint ?? null,
        topic_primary: e.topicPrimary ?? null,
        ai_action: e.aiAction ?? null
      }));

    if (interactions.length === 0) return { ok: true };

    const url = `${SHAPED_BASE_URL}/v2/tables/${interactionsTable(env)}/insert`;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        ...shapedHeaders(env),
        "Content-Type": "application/json"
      },
      body: buildInsertPayload(interactions)
    });

    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      log.warn({ event: "shaped_events_fail", httpStatus: resp.status, count: interactions.length, detail: detail.slice(0, 200) });
      return { ok: false, reason: `http_${resp.status}` };
    }

    return { ok: true };
  } catch (err) {
    log.warn({ event: "shaped_events_error", ...log.fmtError(err) });
    return { ok: false, reason: err.message };
  }
}

/**
 * Ask Shaped to re-rank a set of candidate item IDs for a user.
 * Returns an ordered id[] or [] on timeout/error — caller falls back to local scoring.
 * Never throws.
 */
export async function rankItems(env, userId, candidateIds, { timeoutMs = 800 } = {}) {
  if (!isEnabled(env) || !candidateIds?.length) return [];
  try {
    const url = `${SHAPED_BASE_URL}/v2/engines/${engineName(env)}/query`;
    const requestedLimit = Math.max(1, candidateIds.length);
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        ...shapedHeaders(env),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        query: buildRankQuery(env, requestedLimit),
        parameters: {
          user_id: userId,
          candidate_item_ids: candidateIds
        }
      }),
      signal: AbortSignal.timeout(timeoutMs)
    });

    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      log.warn({ event: "shaped_rank_fail", httpStatus: resp.status, detail: detail.slice(0, 200) });
      return [];
    }

    const data = await resp.json();
    const ranked = data?.results ?? data?.items ?? [];
    if (!Array.isArray(ranked)) {
      return [];
    }
    return ranked
      .map((item) => item?.item_id ?? item?.id ?? item)
      .filter(Boolean)
      .map(String);
  } catch (err) {
    log.warn({ event: "shaped_rank_error", ...log.fmtError(err) });
    return [];
  }
}

