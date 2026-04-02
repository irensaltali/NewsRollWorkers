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

  try {
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
    log.info({ event: "analytics_write_ok", userId, count: events.length });
  } catch (err) {
    log.warn({ event: "analytics_write_fail", userId, count: events.length, ...log.fmtError(err) });
    return { stored: 0 };
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

export async function queryStoryStats(env, days = 90) {
  if (!hasEventAnalyticsQueryConfig(env)) return [];

  try {
    return await queryEventAnalytics(env, `
      SELECT
        blob2 AS story_id,
        sumIf(_sample_interval, blob3 = 'impression') AS impression_count,
        sumIf(_sample_interval, blob3 = 'dwell' OR blob3 = 'complete' OR blob3 = 'vote' OR blob3 = 'save' OR blob3 = 'share' OR blob3 = 'detail_open' OR blob3 = 'external_open') AS engagement_count
      FROM ${eventAnalyticsTable(env)}
      WHERE timestamp > NOW() - INTERVAL '${Math.max(1, days)}' DAY
      GROUP BY story_id
    `);
  } catch (err) {
    log.warn({ event: "event_analytics_query_fail", query: "story_stats", ...log.fmtError(err) });
    return [];
  }
}

