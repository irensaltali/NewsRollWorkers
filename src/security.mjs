// Supabase JWT verification using native Web Crypto (no external library needed).
// Supabase issues HS256 JWTs signed with SUPABASE_JWT_SECRET.

const encoder = new TextEncoder();

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

export async function verifySupabaseJWT(token, jwtSecret) {
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

  let claims;
  try {
    claims = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return null;
  }

  if (claims.exp && Date.now() / 1000 > claims.exp) return null;

  return claims; // claims.sub is the user UUID
}
