import * as log from "./log.mjs";
import * as shaped from "./shaped.mjs";
import { batchInsertEvents } from "./db.mjs";

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

export async function storeEvents(env, userId, events) {
  if (!env?.SUPABASE_URL || events.length === 0) {
    return { stored: 0 };
  }

  const { stored } = await batchInsertEvents(env, userId, events);

  log.info({ event: "events_stored", userId, submitted: events.length, stored });

  if (stored > 0) {
    shaped.trackEvents(env, userId, events).catch(() => {});
  }

  return { stored };
}
