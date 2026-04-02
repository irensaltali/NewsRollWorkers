// Test helpers for signing minimal JWTs for worker tests.
// Only intended for test environments — not cryptographically hardened.

import { createHmac, generateKeyPairSync, sign } from "node:crypto";

function base64url(str) {
  return Buffer.from(str).toString("base64url");
}

/**
 * Signs a minimal Supabase-compatible HS256 JWT.
 * @param {string} userId  UUID to embed as `sub`
 * @param {string} secret  Value used as SUPABASE_JWT_SECRET in the test env
 * @returns {string} signed JWT token
 */
export function signTestJWT(userId, secret) {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({
    sub: userId,
    role: "authenticated",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600
  }));
  const signing = `${header}.${payload}`;
  const sig = createHmac("sha256", secret).update(signing).digest("base64url");
  return `${signing}.${sig}`;
}

export function createES256TestJWT(userId, {
  supabaseUrl = "https://snazihvdznshybaogwrx.supabase.co",
  kid = "test-es256-key",
  expiresInSeconds = 3600
} = {}) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });

  const header = base64url(JSON.stringify({ alg: "ES256", kid, typ: "JWT" }));
  const payload = base64url(JSON.stringify({
    iss: `${supabaseUrl.replace(/\/+$/, "")}/auth/v1`,
    sub: userId,
    aud: "authenticated",
    role: "authenticated",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + expiresInSeconds
  }));
  const signingInput = `${header}.${payload}`;
  const signature = sign(null, Buffer.from(signingInput), {
    key: privateKey,
    dsaEncoding: "ieee-p1363"
  }).toString("base64url");

  const jwk = publicKey.export({ format: "jwk" });
  return {
    token: `${signingInput}.${signature}`,
    jwks: {
      keys: [
        {
          ...jwk,
          use: "sig",
          key_ops: ["verify"],
          alg: "ES256",
          kid
        }
      ]
    }
  };
}

export const TEST_JWT_SECRET = "test-supabase-jwt-secret";
export const TEST_USER_ID = "00000000-0000-0000-0000-000000000001";
