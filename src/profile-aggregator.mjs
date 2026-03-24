import * as log from "./log.mjs";

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

export async function aggregateProfile(env, installationId) {
  if (!env?.DB?.prepare) return null;

  const events = await env.DB.prepare(
    `SELECT e.story_id AS storyId, e.event_type AS eventType, e.event_value AS eventValue, e.created_at AS createdAt,
            p.topics, p.source_endpoint AS sourceEndpoint
     FROM user_events e
     LEFT JOIN published_feed_entries p ON p.story_id = e.story_id
     WHERE e.installation_id = ?1
       AND e.created_at > datetime('now', '-30 days')
     ORDER BY e.created_at DESC
     LIMIT 1000`
  ).bind(installationId).all();

  const rows = events.results ?? [];
  if (rows.length === 0) {
    log.debug({ event: "aggregate_skip", installationId, reason: "no_events" });
    return null;
  }

  const topicScores = {};
  const endpointScores = {};
  let totalImpressions = 0;
  let totalEngagements = 0;
  const now = Date.now();

  for (const row of rows) {
    const weight = EVENT_WEIGHTS[row.eventType] ?? 0;
    const daysAgo = (now - new Date(row.createdAt).getTime()) / (1000 * 60 * 60 * 24);
    const decay = decayFactor(daysAgo);
    const effectiveWeight = weight * decay;

    if (row.eventType === "dwell" && row.eventValue) {
      try {
        const val = JSON.parse(row.eventValue);
        if (val.dwell_ms && val.dwell_ms < 3000) {
          continue;
        }
      } catch {}
    }

    if (row.eventType === "impression") {
      totalImpressions++;
    } else if (weight > 0) {
      totalEngagements++;
    }

    let topics = [];
    try {
      topics = JSON.parse(row.topics ?? "[]");
    } catch {}

    for (const topic of topics) {
      topicScores[topic] = (topicScores[topic] ?? 0) + effectiveWeight;
    }

    if (row.sourceEndpoint) {
      endpointScores[row.sourceEndpoint] = (endpointScores[row.sourceEndpoint] ?? 0) + effectiveWeight;
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

  const profile = {
    topicScores,
    endpointScores,
    totalImpressions,
    totalEngagements
  };

  await env.DB.prepare(
    `INSERT INTO user_profiles (installation_id, topic_scores, endpoint_scores, media_pref, total_impressions, total_engagements, updated_at)
     VALUES (?1, ?2, ?3, '{}', ?4, ?5, datetime('now'))
     ON CONFLICT(installation_id) DO UPDATE SET
       topic_scores = excluded.topic_scores,
       endpoint_scores = excluded.endpoint_scores,
       total_impressions = excluded.total_impressions,
       total_engagements = excluded.total_engagements,
       updated_at = excluded.updated_at`
  ).bind(
    installationId,
    JSON.stringify(topicScores),
    JSON.stringify(endpointScores),
    totalImpressions,
    totalEngagements
  ).run();

  log.info({
    event: "profile_aggregated",
    installationId,
    topicCount: Object.keys(topicScores).length,
    totalImpressions,
    totalEngagements
  });

  return profile;
}

export async function aggregateStaleProfiles(env, limit = 100) {
  if (!env?.DB?.prepare) return 0;

  const stale = await env.DB.prepare(
    `SELECT DISTINCT e.installation_id AS installationId
     FROM user_events e
     LEFT JOIN user_profiles p ON p.installation_id = e.installation_id
     WHERE p.installation_id IS NULL
        OR p.updated_at < datetime('now', '-1 hour')
     GROUP BY e.installation_id
     HAVING COUNT(*) > 5
     LIMIT ?1`
  ).bind(limit).all();

  const installationIds = (stale.results ?? []).map((r) => r.installationId);
  let aggregated = 0;

  for (const installationId of installationIds) {
    try {
      await aggregateProfile(env, installationId);
      aggregated++;
    } catch (err) {
      log.warn({ event: "aggregate_fail", installationId, ...log.fmtError(err) });
    }
  }

  if (aggregated > 0) {
    log.info({ event: "stale_profiles_aggregated", count: aggregated });
  }
  return aggregated;
}
