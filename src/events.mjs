import * as log from "./log.mjs";
import * as shaped from "./shaped.mjs";
import { enrichEventsWithStoryContext, upsertUserSessionsFromEvents } from "./db.mjs";
import { writeEventBatch } from "./event-analytics.mjs";

export const VALID_EVENT_TYPES = new Set([
  "impression",
  "dwell",
  "complete",
  "vote",
  "save",
  "share",
  "skip",
  "hide",
  "detail_open",
  "external_open",
  "ai_summary_request",
  "ai_explain_request",
  "ai_translate_request",
  "ai_thread_intelligence_request"
]);

function normalizeMetadata(value) {
  if (!value) {
    return null;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return typeof value === "object" && !Array.isArray(value) ? value : null;
}

function normalizeInteger(value) {
  if (value == null || value === "") {
    return null;
  }
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeBoolean(value) {
  if (value == null || value === "") {
    return null;
  }
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return null;
}

export function labelForEvent(eventType, dwellMs = null) {
  switch (eventType) {
    case "hide":
      return -2.0;
    case "skip":
      return dwellMs != null && dwellMs < 1500 ? -1.0 : -0.5;
    case "impression":
      return 0.05;
    case "dwell":
      if (dwellMs == null) return 0.1;
      if (dwellMs < 3000) return 0.1;
      if (dwellMs <= 10000) return 0.3;
      return 0.75;
    case "detail_open":
      return 1.0;
    case "external_open":
      return 1.25;
    case "complete":
      return 1.0;
    case "share":
    case "save":
    case "vote":
      return 2.0;
    case "ai_summary_request":
      return 0.6;
    case "ai_explain_request":
      return 0.8;
    case "ai_translate_request":
      return 0.5;
    case "ai_thread_intelligence_request":
      return 0.7;
    default:
      return 0;
  }
}

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

    const metadata = normalizeMetadata(event.metadata ?? event.eventValue);
    const dwellMs = normalizeInteger(event.dwellMs ?? metadata?.dwell_ms);

    valid.push({
      eventId: typeof event.eventId === "string" && event.eventId.trim().length > 0
        ? event.eventId.trim()
        : crypto.randomUUID(),
      storyId: event.storyId,
      eventType: event.eventType,
      occurredAt: typeof event.occurredAt === "string" && event.occurredAt.trim().length > 0
        ? event.occurredAt
        : new Date().toISOString(),
      sessionId: typeof event.sessionId === "string" && event.sessionId.trim().length > 0
        ? event.sessionId.trim()
        : null,
      surface: typeof event.surface === "string" && event.surface.trim().length > 0
        ? event.surface.trim()
        : "unknown",
      position: normalizeInteger(event.position),
      feedMode: typeof event.feedMode === "string" && event.feedMode.trim().length > 0
        ? event.feedMode.trim()
        : null,
      dwellMs,
      metadata,
      aiAction: event.eventType.startsWith("ai_") ? event.eventType : (typeof metadata?.ai_action === "string" ? metadata.ai_action : null),
      aiCached: normalizeBoolean(metadata?.cached),
      aiCreditsUsed: normalizeInteger(metadata?.credits_used),
      label: labelForEvent(event.eventType, dwellMs)
    });
  }

  return { valid, rejected };
}

export async function storeEvents(env, userId, events) {
  if (events.length === 0) {
    return { stored: 0 };
  }

  const enrichedEvents = await enrichEventsWithStoryContext(env, events);
  await upsertUserSessionsFromEvents(env, userId, enrichedEvents);
  const { stored } = await writeEventBatch(env, userId, enrichedEvents);

  log.info({ event: "events_stored", userId, submitted: events.length, stored });

  shaped.trackEvents(env, userId, enrichedEvents).catch(() => {});

  return { stored };
}
