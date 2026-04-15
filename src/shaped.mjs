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

function normalizeTopics(value) {
  if (!Array.isArray(value)) return null;
  const topics = value.filter((v) => typeof v === "string" && v.trim()).map((v) => v.trim());
  return topics.length > 0 ? topics : null;
}

function normalizeString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function buildInsertPayload(rows) {
  return JSON.stringify({ data: rows });
}

/**
 * Upsert a single article item into the Shaped catalog.
 * Fire-and-forget safe — never throws to caller.
 */
export async function upsertItem(env, item) {
  if (!isEnabled(env)) {
    log.warn({ event: "shaped_disabled", storyId: item.storyId, reason: "missing_api_key" });
    return { ok: true };
  }
  try {
    const shapedItem = {
      item_id: String(item.storyId),
      created_at: item.publishedAt ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
      // headline: AI-extracted; title: RSS original — Shaped uses COALESCE(headline, title) for embeddings
      headline: item.headline ?? item.title ?? null,
      title: item.title ?? null,
      summary: normalizeString(item.summary),
      category: normalizeString(item.category),
      topics: normalizeTopics(item.topics),
      media_url: item.mediaUrl ?? null,
      media_type: item.mediaType ?? null,
      media_provider: item.mediaProvider ?? null,
      media_model: item.mediaModel ?? null,
      optimizer_config_id: item.optimizerConfigId ?? null,
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

    log.info({ event: "shaped_upsert_ok", storyId: item.storyId });
    return { ok: true };
  } catch (err) {
    log.warn({ event: "shaped_upsert_error", storyId: item.storyId, ...log.fmtError(err) });
    return { ok: false, reason: err.message };
  }
}

/**
 * Query Shaped for personalized feed recommendations for a user.
 * Returns { results: [{id, score}], paginationKey: string|null }.
 * Uses Shaped's pagination_key mechanism for stateful server-side paging.
 * Never throws to caller — returns empty results on any failure.
 */
export async function queryPersonalizedFeed(env, userId, { count = 20, paginationKey = null } = {}) {
  const empty = { results: [], paginationKey: null };
  if (!isEnabled(env)) {
    log.warn({ event: "shaped_disabled", reason: "missing_api_key" });
    return empty;
  }
  if (!userId) return empty;
  try {
    const url = `${SHAPED_BASE_URL}/v2/engines/${engineName(env)}/queries/personalized_trending_feed`;
    const body = {
      parameters: {
        user_id: userId,
        count
      }
    };
    if (paginationKey) {
      body.pagination_key = paginationKey;
    }
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        ...shapedHeaders(env),
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      log.warn({ event: "shaped_query_fail", userId, httpStatus: resp.status, detail: detail.slice(0, 200) });
      return empty;
    }

    const data = await resp.json();
    const results = (data.results ?? []).map((r) => ({ id: String(r.id), score: r.score ?? 0 }));
    return {
      results,
      paginationKey: data.pagination_key ?? null
    };
  } catch (err) {
    log.warn({ event: "shaped_query_error", userId, ...log.fmtError(err) });
    return empty;
  }
}

/**
 * Forward a batch of user interaction events to Shaped.
 * Fire-and-forget safe — never throws to caller.
 */
export async function trackEvents(env, userId, events) {
  if (!isEnabled(env)) {
    log.warn({ event: "shaped_disabled", reason: "missing_api_key" });
    return { ok: true };
  }
  if (!events?.length) return { ok: true };
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
        feed_mode: e.feedMode ?? null,
        dwell_ms: e.dwellMs ?? null,
        media_type: e.mediaType ?? null,
        topics: normalizeTopics(e.topics),
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
