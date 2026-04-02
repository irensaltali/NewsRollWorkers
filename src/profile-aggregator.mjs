import * as log from "./log.mjs";
import { createClient } from "@supabase/supabase-js";
import { getSupabaseSecretKey } from "./db.mjs";
import { queryProfileEvents, queryStaleProfileUsers } from "./event-analytics.mjs";

const EVENT_WEIGHTS = {
  ai_summary_request: 0.6,
  ai_explain_request: 0.8,
  ai_translate_request: 0.5,
  ai_thread_intelligence_request: 0.7,
  external_open: 1.25,
  detail_open: 1.0,
  vote: 3.0,
  save: 2.0,
  share: 2.0,
  complete: 1.0,
  dwell: 0.3,
  impression: 0.05,
  skip: -1.0,
  hide: -2.0
};

const DECAY_HALFLIFE_DAYS = 7;

function decayFactor(daysAgo) {
  return Math.pow(0.5, daysAgo / DECAY_HALFLIFE_DAYS);
}

function getDB(env) {
  return createClient(env.SUPABASE_URL, getSupabaseSecretKey(env), {
    auth: { persistSession: false }
  });
}

export function computeProfileData(rows) {
  if (!rows || rows.length === 0) return null;

  const topicScores = {};
  const endpointScores = {};
  let totalImpressions = 0;
  let totalEngagements = 0;
  const now = Date.now();

  for (const row of rows) {
    const eventType = row.event_type ?? row.eventType;
    const createdAt = row.created_at ?? row.createdAt;
    const sourceEndpoint = row.source_endpoint ?? row.sourceEndpoint;
    const weight = Number(row.label ?? row.eventLabel ?? EVENT_WEIGHTS[eventType] ?? 0);
    const eventCount = Math.max(1, Number(row.event_count ?? row.eventCount ?? 1));
    const daysAgo = (now - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24);
    const decay = decayFactor(daysAgo);
    const effectiveWeight = weight * decay * eventCount;

    if (eventType === "impression") {
      totalImpressions += eventCount;
    } else if (weight > 0) {
      totalEngagements += eventCount;
    }

    const topics = Array.isArray(row.topics)
      ? row.topics
      : (typeof row.topics === "string"
          ? JSON.parse(row.topics)
          : (typeof row.topics_json === "string" && row.topics_json
              ? JSON.parse(row.topics_json)
              : (row.topic_primary ? [row.topic_primary] : [])));

    for (const topic of topics) {
      topicScores[topic] = (topicScores[topic] ?? 0) + effectiveWeight;
    }

    if (sourceEndpoint) {
      endpointScores[sourceEndpoint] = (endpointScores[sourceEndpoint] ?? 0) + effectiveWeight;
    }
  }

  const maxTopic = Math.max(...Object.values(topicScores), 1);
  for (const key of Object.keys(topicScores)) {
    topicScores[key] = Math.round((topicScores[key] / maxTopic) * 1000) / 1000;
  }

  const maxEndpoint = Math.max(...Object.values(endpointScores), 1);
  for (const key of Object.keys(endpointScores)) {
    endpointScores[key] = Math.round((endpointScores[key] / maxEndpoint) * 1000) / 1000;
  }

  return { topicScores, endpointScores, totalImpressions, totalEngagements };
}

export async function aggregateProfile(env, userId) {
  if (!env?.SUPABASE_URL || !getSupabaseSecretKey(env)) return null;

  const rows = await queryProfileEvents(env, userId, 30);

  if (rows.length === 0) {
    log.debug({ event: "aggregate_skip", userId, reason: "no_events" });
    return null;
  }

  const profile = computeProfileData(rows);
  if (!profile) return null;

  await getDB(env)
    .from("user_profiles")
    .upsert({
      user_id: userId,
      topic_scores: profile.topicScores,
      endpoint_scores: profile.endpointScores,
      media_pref: {},
      total_impressions: profile.totalImpressions,
      total_engagements: profile.totalEngagements,
      updated_at: new Date().toISOString()
    });

  log.info({
    event: "profile_aggregated",
    userId,
    topicCount: Object.keys(profile.topicScores).length,
    totalImpressions: profile.totalImpressions,
    totalEngagements: profile.totalEngagements
  });

  return profile;
}

export async function aggregateStaleProfiles(env, limit = 100) {
  if (!env?.SUPABASE_URL || !getSupabaseSecretKey(env)) return 0;

  const userIds = await queryStaleProfileUsers(env, limit);
  let aggregated = 0;

  for (const userId of userIds) {
    try {
      await aggregateProfile(env, userId);
      aggregated++;
    } catch (err) {
      log.warn({ event: "aggregate_fail", userId, error: String(err) });
    }
  }

  if (aggregated > 0) {
    log.info({ event: "stale_profiles_aggregated", count: aggregated });
  }
  return aggregated;
}
