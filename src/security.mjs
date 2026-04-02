// Supabase JWT verification supporting modern asymmetric signing keys via JWKS,
// while preserving HS256 validation for local/test environments.

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const JWKS_CACHE_TTL_MS = 10 * 60 * 1000;
const jwksCache = new Map();

function base64urlDecode(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function decodeJWTPart(part) {
  try {
    return JSON.parse(decoder.decode(base64urlDecode(part)));
  } catch {
    return null;
  }
}

function normalizeSupabaseIssuer(supabaseUrl) {
  if (!supabaseUrl) return null;
  return `${supabaseUrl.replace(/\/+$/, "")}/auth/v1`;
}

function claimsAreCurrent(claims) {
  if (!claims || typeof claims !== "object") return false;
  if (claims.exp && Date.now() / 1000 > claims.exp) return false;
  return true;
}

function claimsMatchIssuer(claims, supabaseUrl) {
  const expectedIssuer = normalizeSupabaseIssuer(supabaseUrl);
  if (!expectedIssuer) return true;
  return claims?.iss === expectedIssuer;
}

async function verifyHS256(token, jwtSecret) {
  if (!jwtSecret) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts;

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(jwtSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    base64urlDecode(sig),
    encoder.encode(`${header}.${payload}`)
  );

  if (!valid) return null;

  const claims = decodeJWTPart(payload);
  if (!claimsAreCurrent(claims)) return null;
  return claims;
}

async function fetchJWKS(supabaseUrl) {
  const cacheKey = supabaseUrl.replace(/\/+$/, "");
  const cached = jwksCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < JWKS_CACHE_TTL_MS) {
    return cached.keys;
  }

  const jwksURL = `${cacheKey}/auth/v1/.well-known/jwks.json`;
  const response = await fetch(jwksURL);
  if (!response.ok) {
    return [];
  }

  const payload = await response.json().catch(() => null);
  const keys = Array.isArray(payload?.keys) ? payload.keys : [];
  jwksCache.set(cacheKey, {
    fetchedAt: Date.now(),
    keys
  });
  return keys;
}

function matchingJWK(keys, header) {
  if (!Array.isArray(keys) || !header) return null;

  if (header.kid) {
    return keys.find((key) => key?.kid === header.kid && (!key.alg || key.alg === header.alg)) ?? null;
  }

  return keys.find((key) => !key.alg || key.alg === header.alg) ?? null;
}

function importAlgorithmForHeader(alg) {
  switch (alg) {
    case "ES256":
      return { name: "ECDSA", namedCurve: "P-256" };
    case "RS256":
      return { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
    default:
      return null;
  }
}

function verifyAlgorithmForHeader(alg) {
  switch (alg) {
    case "ES256":
      return { name: "ECDSA", hash: "SHA-256" };
    case "RS256":
      return { name: "RSASSA-PKCS1-v1_5" };
    default:
      return null;
  }
}

async function verifyWithJWKS(token, supabaseUrl) {
  if (!supabaseUrl) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, sigPart] = parts;

  const header = decodeJWTPart(headerPart);
  const claims = decodeJWTPart(payloadPart);
  if (!header || !claims) return null;
  if (!claimsAreCurrent(claims) || !claimsMatchIssuer(claims, supabaseUrl)) return null;

  const importAlgorithm = importAlgorithmForHeader(header.alg);
  const verifyAlgorithm = verifyAlgorithmForHeader(header.alg);
  if (!importAlgorithm || !verifyAlgorithm) return null;

  const keys = await fetchJWKS(supabaseUrl);
  const jwk = matchingJWK(keys, header);
  if (!jwk) return null;

  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    importAlgorithm,
    false,
    ["verify"]
  );

  const valid = await crypto.subtle.verify(
    verifyAlgorithm,
    key,
    base64urlDecode(sigPart),
    encoder.encode(`${headerPart}.${payloadPart}`)
  );

  return valid ? claims : null;
}

export async function verifySupabaseJWT(token, options = {}) {
  if (!token || typeof token !== "string") return null;

  const headerPart = token.split(".", 1)[0];
  const header = decodeJWTPart(headerPart);
  if (!header?.alg) return null;

  if (header.alg === "HS256") {
    return verifyHS256(token, options.jwtSecret);
  }

  return verifyWithJWKS(token, options.supabaseUrl);
}
