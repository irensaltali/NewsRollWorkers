import * as log from "./log.mjs";

export const DEFAULT_EVENT_ANALYTICS_DATASET = "newsroll_user_events";

function datasetName(env) {
  const dataset = env?.EVENT_ANALYTICS_DATASET ?? DEFAULT_EVENT_ANALYTICS_DATASET;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(dataset)) {
    throw new Error(`Invalid Analytics Engine dataset name: ${dataset}`);
  }
  return dataset;
}

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function eventAnalyticsTable(env) {
  return datasetName(env);
}

export function hasEventAnalyticsWriteBinding(env) {
  return typeof env?.EVENT_ANALYTICS?.writeDataPoint === "function";
}

export function hasEventAnalyticsQueryConfig(env) {
  return typeof env?.CLOUDFLARE_ACCOUNT_ID === "string" &&
    env.CLOUDFLARE_ACCOUNT_ID.length > 0 &&
    typeof env?.CLOUDFLARE_API_TOKEN === "string" &&
    env.CLOUDFLARE_API_TOKEN.length > 0;
}

function analyticsEndpoint(env) {
  return `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/analytics_engine/sql`;
}

export async function writeEventBatch(env, userId, events) {
  if (!events?.length) {
    return { stored: 0 };
  }
  if (!hasEventAnalyticsWriteBinding(env)) {
    log.warn({ event: "event_analytics_unavailable", reason: "missing_binding", count: events.length });
    return { stored: 0 };
  }

  for (const event of events) {
    env.EVENT_ANALYTICS.writeDataPoint({
      indexes: [String(userId)],
      blobs: [
        String(userId),
        String(event.storyId),
        event.eventType,
        event.sessionId ?? "",
        event.surface ?? "unknown",
        event.feedMode ?? "",
        event.mediaType ?? "",
        event.sourceEndpoint ?? "",
        event.aiAction ?? "",
        event.eventId ?? ""
      ],
      doubles: [
        1,
        Number(event.label ?? 0),
        Number(event.dwellMs ?? 0),
        Number(event.aiCreditsUsed ?? 0)
      ]
    });
  }

  return { stored: events.length };
}

export async function queryEventAnalytics(env, query) {
  if (!hasEventAnalyticsQueryConfig(env)) {
    return [];
  }

  const response = await fetch(analyticsEndpoint(env), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`
    },
    body: query
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Analytics Engine query failed (${response.status}): ${detail.slice(0, 200)}`);
  }

  const payload = await response.json();
  return Array.isArray(payload?.data) ? payload.data : [];
}

export async function querySeenStoryIds(env, userId, days = 7) {
  if (!hasEventAnalyticsQueryConfig(env)) return [];

  try {
    const rows = await queryEventAnalytics(env, `
      SELECT blob2 AS story_id
      FROM ${eventAnalyticsTable(env)}
      WHERE blob1 = ${sqlString(userId)}
        AND blob3 = 'impression'
        AND timestamp > NOW() - INTERVAL '${Math.max(1, days)}' DAY
      GROUP BY story_id
    `);

    return rows
      .map((row) => Number.parseInt(row.story_id, 10))
      .filter(Number.isInteger);
  } catch (err) {
    log.warn({ event: "event_analytics_query_fail", query: "seen_story_ids", userId, ...log.fmtError(err) });
    return [];
  }
}

export async function queryStoryStats(env, days = 90) {
  if (!hasEventAnalyticsQueryConfig(env)) return [];

  try {
    return await queryEventAnalytics(env, `
      SELECT
        blob2 AS story_id,
        SUM(CASE WHEN blob3 = 'impression' THEN _sample_interval ELSE 0 END) AS impression_count,
        SUM(CASE WHEN blob3 IN ('dwell', 'complete', 'vote', 'save', 'share', 'detail_open', 'external_open') THEN _sample_interval ELSE 0 END) AS engagement_count
      FROM ${eventAnalyticsTable(env)}
      WHERE timestamp > NOW() - INTERVAL '${Math.max(1, days)}' DAY
      GROUP BY story_id
    `);
  } catch (err) {
    log.warn({ event: "event_analytics_query_fail", query: "story_stats", ...log.fmtError(err) });
    return [];
  }
}

export async function queryProfileEvents(env, userId, days = 30) {
  if (!hasEventAnalyticsQueryConfig(env)) return [];

  try {
    return await queryEventAnalytics(env, `
      SELECT
        blob3 AS event_type,
        blob8 AS source_endpoint,
        double2 AS label,
        timestamp AS created_at
      FROM ${eventAnalyticsTable(env)}
      WHERE blob1 = ${sqlString(userId)}
        AND timestamp > NOW() - INTERVAL '${Math.max(1, days)}' DAY
      ORDER BY timestamp DESC
      LIMIT 5000
    `);
  } catch (err) {
    log.warn({ event: "event_analytics_query_fail", query: "profile_events", userId, ...log.fmtError(err) });
    return [];
  }
}

export async function queryStaleProfileUsers(env, limit = 100) {
  if (!hasEventAnalyticsQueryConfig(env)) return [];

  try {
    const rows = await queryEventAnalytics(env, `
      SELECT blob1 AS user_id, MAX(timestamp) AS last_event_at
      FROM ${eventAnalyticsTable(env)}
      WHERE timestamp > NOW() - INTERVAL '30' DAY
      GROUP BY user_id
      ORDER BY last_event_at DESC
      LIMIT ${Math.max(1, Math.min(limit, 1000))}
    `);

    return rows
      .map((row) => row.user_id)
      .filter((value) => typeof value === "string" && value.length > 0);
  } catch (err) {
    log.warn({ event: "event_analytics_query_fail", query: "stale_profile_users", ...log.fmtError(err) });
    return [];
  }
}
