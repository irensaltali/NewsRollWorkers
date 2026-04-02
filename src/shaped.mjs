import * as log from "./log.mjs";

const SHAPED_BASE_URL = "https://api.shaped.ai";
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

function itemsTable(env) {
  return env?.SHAPED_ITEMS_TABLE ?? DEFAULT_ITEMS_TABLE;
}

function interactionsTable(env) {
  return env?.SHAPED_INTERACTIONS_TABLE ?? DEFAULT_INTERACTIONS_TABLE;
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
      category: item.category ?? item.sourceEndpoint ?? null,
      source_endpoint: item.sourceEndpoint ?? null,
      media_url: item.mediaUrl ?? null,
      media_type: item.mediaType ?? null,
      media_provider: item.mediaProvider ?? null,
      media_model: item.mediaModel ?? null,
      prompt_template_id: item.promptTemplateId ?? null,
      prompt_template_name: item.promptTemplateName ?? null,
      duplicate_cluster_size: item.duplicateClusterSize ?? 1,
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
        feed_mode: e.feedMode ?? null,
        dwell_ms: e.dwellMs ?? null,
        media_type: e.mediaType ?? null,
        source_endpoint: e.sourceEndpoint ?? null,
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

