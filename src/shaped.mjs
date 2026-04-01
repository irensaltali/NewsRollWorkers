import * as log from "./log.mjs";
import {
  getStoryVelocityWindow,
  updatePublishedFeedEntryVelocity,
  getPublishedEntryForVelocitySync
} from "./db.mjs";

// ⚠️ VERIFY all endpoint paths, header names, and response shapes from
//    https://docs.shaped.ai before deploying with a real API key.
const SHAPED_BASE_URL   = "https://api.shaped.ai"; // VERIFY
const SHAPED_MODEL_ID   = "newsroll_stories";       // configure in Shaped dashboard
const SHAPED_DATASET_ID = "newsroll_articles";      // configure in Shaped dashboard

function isEnabled(env) {
  return typeof env?.SHAPED_API_KEY === "string" && env.SHAPED_API_KEY.length > 0;
}

function shapedHeaders(env) {
  return {
    "Content-Type": "application/json",
    "x-api-key": env.SHAPED_API_KEY // VERIFY header name from Shaped docs
  };
}

/**
 * Upsert a single article item into the Shaped catalog.
 * Fire-and-forget safe — never throws to caller.
 */
export async function upsertItem(env, item) {
  if (!isEnabled(env)) return { ok: true };
  try {
    const shapedItem = {
      id:                       String(item.storyId),
      published_at:             item.publishedAt ?? null,
      topics:                   item.topics ?? [],
      publisher:                item.publisher ?? null,
      language:                 item.language ?? "en",
      entities:                 item.entities ?? [],
      quality_score:            item.qualityScore ?? 0.5,
      novelty_score:            item.noveltyScore ?? 0.5,
      publisher_tier:           item.publisherTier ?? 2,
      source_reliability_score: item.sourceReliabilityScore ?? 0.5,
      has_author:               Boolean(item.hasAuthor),
      article_length:           item.articleLength ?? null,
      ctr_5m:                   item.ctr5m ?? 0.0,
      ctr_30m:                  item.ctr30m ?? 0.0,
      ctr_2h:                   item.ctr2h ?? 0.0,
      save_rate_2h:             item.saveRate2h ?? 0.0,
      skip_rate_30m:            item.skipRate30m ?? 0.0,
      completion_rate_2h:       item.completionRate2h ?? 0.0,
      engagement_count:         item.engagementCount ?? 0,
      impression_count:         item.impressionCount ?? 0,
      duplicate_cluster_size:   item.duplicateClusterSize ?? 1
      // TODO: title_embedding, body_embedding (future)
    };

    // VERIFY endpoint from Shaped docs — likely POST /v1/datasets/{id}/items
    const url = `${SHAPED_BASE_URL}/v1/datasets/${SHAPED_DATASET_ID}/items`;
    const resp = await fetch(url, {
      method: "POST",
      headers: shapedHeaders(env),
      body: JSON.stringify({ items: [shapedItem] })
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

// VERIFY all mapped values against Shaped's supported interaction types
const EVENT_TYPE_MAP = {
  impression: "VIEW",
  dwell:      "VIEW",
  complete:   "COMPLETE",
  vote:       "LIKE",
  save:       "SAVE",
  share:      "SHARE",
  skip:       "SKIP",
  hide:       "DISLIKE"
};

/**
 * Forward a batch of user interaction events to Shaped.
 * Fire-and-forget safe — never throws to caller.
 */
export async function trackEvents(env, userId, events) {
  if (!isEnabled(env) || !events?.length) return { ok: true };
  try {
    const now = new Date().toISOString();
    const interactions = events
      .filter((e) => EVENT_TYPE_MAP[e.eventType])
      .map((e) => {
        const interaction = {
          user_id:    userId,
          item_id:    String(e.storyId),
          event_type: EVENT_TYPE_MAP[e.eventType],
          timestamp:  now
        };
        if (e.eventType === "dwell" && e.eventValue) {
          const val = typeof e.eventValue === "string" ? JSON.parse(e.eventValue) : e.eventValue;
          if (val?.dwell_ms != null) interaction.properties = { dwell_ms: val.dwell_ms };
        }
        return interaction;
      });

    if (interactions.length === 0) return { ok: true };

    // VERIFY endpoint from Shaped docs — likely POST /v1/models/{id}/events
    const url = `${SHAPED_BASE_URL}/v1/models/${SHAPED_MODEL_ID}/events`;
    const resp = await fetch(url, {
      method: "POST",
      headers: shapedHeaders(env),
      body: JSON.stringify({ events: interactions })
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
    // VERIFY endpoint and request/response shape from Shaped docs
    const url = `${SHAPED_BASE_URL}/v1/models/${SHAPED_MODEL_ID}/rank`;
    const resp = await fetch(url, {
      method: "POST",
      headers: shapedHeaders(env),
      body: JSON.stringify({
        user_id:  userId,
        item_ids: candidateIds,
        limit:    candidateIds.length
      }),
      signal: AbortSignal.timeout(timeoutMs)
    });

    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      log.warn({ event: "shaped_rank_fail", httpStatus: resp.status, detail: detail.slice(0, 200) });
      return [];
    }

    const data = await resp.json();
    // VERIFY response field name from Shaped docs
    const ranked = data?.ranked_item_ids ?? data?.item_ids ?? data?.items ?? [];
    return Array.isArray(ranked) ? ranked.map(String) : [];
  } catch (err) {
    log.warn({ event: "shaped_rank_error", ...log.fmtError(err) });
    return [];
  }
}

/**
 * Compute velocity signals for one story from Supabase and push the updated item to Shaped.
 * Called by updateVelocitySignals() in the cron loop.
 * Never throws.
 */
export async function refreshItemVelocity(env, storyId) {
  if (!env?.SUPABASE_URL) return null;
  try {
    const [w5m, w30m, w2h] = await Promise.all([
      getStoryVelocityWindow(env, storyId, 5),
      getStoryVelocityWindow(env, storyId, 30),
      getStoryVelocityWindow(env, storyId, 120)
    ]);

    const ctr5m            = _ctr(w5m);
    const ctr30m           = _ctr(w30m);
    const ctr2h            = _ctr(w2h);
    const saveRate2h       = _rate(w2h.saves,     w2h.imp);
    const skipRate30m      = _rate(w30m.skips,    w30m.imp);
    const completionRate2h = _rate(w2h.completes, w2h.imp);

    const signals = { ctr5m, ctr30m, ctr2h, saveRate2h, skipRate30m, completionRate2h };

    await updatePublishedFeedEntryVelocity(env, storyId, signals);

    const entry = await getPublishedEntryForVelocitySync(env, storyId);
    if (entry) {
      upsertItem(env, { ...entry, ...signals }).catch(() => {});
    }

    return signals;
  } catch (err) {
    log.warn({ event: "shaped_velocity_error", storyId, ...log.fmtError(err) });
    return null;
  }
}

function _ctr({ imp, eng }) {
  return imp > 0 ? eng / imp : 0;
}

function _rate(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0;
}
