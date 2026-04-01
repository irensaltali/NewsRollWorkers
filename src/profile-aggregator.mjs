import * as log from "./log.mjs";
import { createClient } from "@supabase/supabase-js";

const EVENT_WEIGHTS = {
  vote: 3.0,
  save: 2.0,
  share: 2.0,
  complete: 1.5,
  dwell: 1.0,
  impression: 0.1,
  skip: -0.2,
  hide: -1.0
};

const DECAY_HALFLIFE_DAYS = 7;

function decayFactor(daysAgo) {
  return Math.pow(0.5, daysAgo / DECAY_HALFLIFE_DAYS);
}

function getDB(env) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
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
    const weight = EVENT_WEIGHTS[eventType] ?? 0;
    const daysAgo = (now - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24);
    const decay = decayFactor(daysAgo);
    const effectiveWeight = weight * decay;

    if (eventType === "dwell" && row.event_value) {
      const val = typeof row.event_value === "string" ? JSON.parse(row.event_value) : row.event_value;
      if (val?.dwell_ms && val.dwell_ms < 3000) continue;
    }

    if (eventType === "impression") {
      totalImpressions++;
    } else if (weight > 0) {
      totalEngagements++;
    }

    const topics = Array.isArray(row.topics)
      ? row.topics
      : (typeof row.topics === "string" ? JSON.parse(row.topics) : []);

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
  if (!env?.SUPABASE_URL) return null;

  const { data } = await getDB(env).rpc("get_profile_events", {
    p_user_id: userId,
    p_days: 30
  });

  const rows = data ?? [];
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
  if (!env?.SUPABASE_URL) return 0;

  const { data } = await getDB(env).rpc("get_stale_profile_users", { p_limit: limit });
  const userIds = (data ?? []).map((r) => r.user_id);
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
