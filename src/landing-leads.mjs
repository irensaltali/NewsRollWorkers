import { insertLandingLead } from "./db.mjs";
import { error, json, readJson } from "./http.mjs";
import * as log from "./log.mjs";

export const VALID_SOURCES = new Set(["early_access", "blog_subscribe", "advertise_inquiry"]);
export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MAX_EMAIL_LENGTH = 254;
export const MAX_PAYLOAD_BYTES = 4096;
const MAX_STRING_VALUE = 2000;

function sanitizeString(value, maxLength = MAX_STRING_VALUE) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
}

function sanitizePayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const result = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof key !== "string" || key.length > 64) continue;
    if (typeof raw === "string") {
      const cleaned = sanitizeString(raw);
      if (cleaned) result[key] = cleaned;
    } else if (typeof raw === "number" && Number.isFinite(raw)) {
      result[key] = raw;
    } else if (typeof raw === "boolean") {
      result[key] = raw;
    }
  }
  return result;
}

async function hashClientIp(request) {
  const ip =
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    null;
  if (!ip) return null;
  const bytes = new TextEncoder().encode(`${ip}|newsroll-landing`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

export function validateLeadBody(body) {
  if (!body || typeof body !== "object") {
    return { ok: false, status: 400, error: "Invalid JSON body" };
  }

  const source = sanitizeString(body.source, 32);
  if (!source || !VALID_SOURCES.has(source)) {
    return {
      ok: false,
      status: 400,
      error: "source must be one of: early_access, blog_subscribe, advertise_inquiry"
    };
  }

  const email = sanitizeString(body.email, MAX_EMAIL_LENGTH)?.toLowerCase();
  if (!email || !EMAIL_REGEX.test(email)) {
    return { ok: false, status: 400, error: "email must be a valid email address" };
  }

  const payload = sanitizePayload(body.payload);
  if (JSON.stringify(payload).length > MAX_PAYLOAD_BYTES) {
    return {
      ok: false,
      status: 413,
      error: `payload exceeds ${MAX_PAYLOAD_BYTES} bytes`
    };
  }

  return { ok: true, source, email, payload };
}

export async function handleLandingLead(request, env) {
  const body = await readJson(request);
  const validation = validateLeadBody(body);
  if (!validation.ok) {
    return error(validation.error, validation.status);
  }

  const { source, email, payload } = validation;
  const userAgent = sanitizeString(request.headers.get("user-agent") ?? "", 512);
  const ipHash = await hashClientIp(request);

  const result = await insertLandingLead(env, {
    source,
    email,
    payload,
    userAgent,
    ipHash
  });

  if (!result.ok) {
    log.warn({ event: "landing_lead_reject", source, reason: result.reason });
    return error("Unable to record lead", 503);
  }

  log.info({
    event: "landing_lead_captured",
    source,
    deduped: result.deduped === true
  });

  return json({ ok: true, deduped: result.deduped === true });
}
