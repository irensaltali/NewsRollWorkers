import * as log from "./log.mjs";

export const VALID_EVENT_TYPES = new Set([
  "impression",
  "dwell",
  "complete",
  "vote",
  "save",
  "share",
  "skip",
  "hide"
]);

const DEDUP_WINDOW_SECONDS = 5;

export function validateEventBatch(events) {
  if (!Array.isArray(events)) {
    return { valid: [], rejected: [{ reason: "events must be an array" }] };
  }

  const valid = [];
  const rejected = [];

  for (const event of events) {
    if (!Number.isInteger(event.storyId) || event.storyId <= 0) {
      rejected.push({ event, reason: "missing or invalid storyId" });
      continue;
    }
    if (!VALID_EVENT_TYPES.has(event.eventType)) {
      rejected.push({ event, reason: `invalid eventType: ${event.eventType}` });
      continue;
    }
    valid.push({
      storyId: event.storyId,
      eventType: event.eventType,
      eventValue: event.eventValue ?? null
    });
  }

  return { valid, rejected };
}

export async function storeEvents(env, installationId, events) {
  if (!env?.DB?.prepare || events.length === 0) {
    return { stored: 0 };
  }

  const statements = events.map((event) =>
    env.DB.prepare(
      `INSERT INTO user_events (installation_id, story_id, event_type, event_value, created_at)
       SELECT ?1, ?2, ?3, ?4, datetime('now')
       WHERE NOT EXISTS (
         SELECT 1 FROM user_events
         WHERE installation_id = ?1
           AND story_id = ?2
           AND event_type = ?3
           AND created_at > datetime('now', '-${DEDUP_WINDOW_SECONDS} seconds')
       )`
    ).bind(
      installationId,
      event.storyId,
      event.eventType,
      event.eventValue ? JSON.stringify(event.eventValue) : null
    )
  );

  const results = await env.DB.batch(statements);
  const stored = results.reduce((sum, r) => sum + (r.meta?.changes ?? 0), 0);

  log.info({
    event: "events_stored",
    installationId,
    submitted: events.length,
    stored
  });

  return { stored };
}
