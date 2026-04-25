import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_PAYLOAD_BYTES,
  VALID_SOURCES,
  validateLeadBody
} from "../src/landing-leads.mjs";
import worker from "../src/index.mjs";

const env = {
  APP_NAME: "NewsRoll",
  ENVIRONMENT: "test"
  // Intentionally no SUPABASE_URL — db.hasDB() returns false, so the handler
  // exercises the full request pipeline and returns 503 without writing anywhere.
};

function postLead(body, { origin = "https://newsroll.app", headers = {} } = {}) {
  return worker.fetch(
    new Request("https://api.newsroll.invalid/landing/lead", {
      method: "POST",
      headers: { "content-type": "application/json", origin, ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body)
    }),
    env,
    { waitUntil: () => {}, passThroughOnException: () => {} }
  );
}

test("validateLeadBody rejects non-object bodies", () => {
  assert.equal(validateLeadBody(null).ok, false);
  assert.equal(validateLeadBody("string").ok, false);
  assert.equal(validateLeadBody([]).ok, false);
});

test("validateLeadBody rejects unknown source", () => {
  const result = validateLeadBody({ source: "something_else", email: "x@y.co" });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.match(result.error, /source must be one of/);
});

test("validateLeadBody rejects invalid email", () => {
  const result = validateLeadBody({ source: "early_access", email: "not-an-email" });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.match(result.error, /valid email/);
});

test("validateLeadBody accepts every whitelisted source", () => {
  for (const source of VALID_SOURCES) {
    const result = validateLeadBody({ source, email: "a@b.co" });
    assert.equal(result.ok, true, `expected ${source} to validate`);
    assert.equal(result.source, source);
  }
});

test("validateLeadBody lowercases email", () => {
  const result = validateLeadBody({ source: "early_access", email: "Mixed@Case.CO" });
  assert.equal(result.ok, true);
  assert.equal(result.email, "mixed@case.co");
});

test("validateLeadBody strips unknown payload field types", () => {
  const result = validateLeadBody({
    source: "advertise_inquiry",
    email: "brand@example.com",
    payload: {
      company: "Example",
      budget: 5000,
      urgent: true,
      nested: { should: "not be allowed" },
      func: () => "dropped"
    }
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.payload, {
    company: "Example",
    budget: 5000,
    urgent: true
  });
});

test("validateLeadBody rejects oversized payloads", () => {
  // Each string field is capped at 2000 chars by the sanitizer, so to exceed
  // the 4096-byte payload limit we spread the content across multiple fields.
  const chunk = "x".repeat(1800);
  const payload = {};
  for (let i = 0; i < 6; i++) payload[`field_${i}`] = chunk;

  const result = validateLeadBody({
    source: "advertise_inquiry",
    email: "brand@example.com",
    payload
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 413);
});

test("POST /landing/lead with valid body but no DB returns 503", async () => {
  const response = await postLead({
    source: "early_access",
    email: "user@example.com"
  });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error, "Unable to record lead");
});

test("POST /landing/lead returns 400 on malformed JSON", async () => {
  const response = await postLead("not-json");
  assert.equal(response.status, 400);
});

test("POST /landing/lead includes CORS headers for allowed origin", async () => {
  const response = await postLead(
    { source: "early_access", email: "user@example.com" },
    { origin: "http://localhost:5173" }
  );
  assert.equal(
    response.headers.get("access-control-allow-origin"),
    "http://localhost:5173"
  );
});

test("OPTIONS /landing/lead preflight succeeds", async () => {
  const response = await worker.fetch(
    new Request("https://api.newsroll.invalid/landing/lead", {
      method: "OPTIONS",
      headers: {
        origin: "https://newsroll.app",
        "access-control-request-method": "POST"
      }
    }),
    env,
    { waitUntil: () => {}, passThroughOnException: () => {} }
  );
  assert.equal(response.status, 204);
  assert.equal(
    response.headers.get("access-control-allow-origin"),
    "https://newsroll.app"
  );
});
