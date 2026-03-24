const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64urlEncode(bytes) {
  const input = typeof bytes === "string" ? encoder.encode(bytes) : bytes;
  let binary = "";
  for (const byte of input) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64urlDecode(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function importHmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

async function deriveAesKey(secret) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function signInstallation(payload, secret) {
  const body = base64urlEncode(JSON.stringify(payload));
  const key = await importHmacKey(secret);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)));
  return `${body}.${base64urlEncode(signature)}`;
}

// 7 days in milliseconds
const MAX_TOKEN_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export async function verifyInstallation(token, secret) {
  const [body, signature] = token.split(".");
  if (!body || !signature) {
    return null;
  }

  const key = await importHmacKey(secret);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    base64urlDecode(signature),
    encoder.encode(body)
  );

  if (!valid) {
    return null;
  }

  const payload = JSON.parse(decoder.decode(base64urlDecode(body)));

  // Reject expired tokens
  if (payload.issuedAt && Date.now() - payload.issuedAt > MAX_TOKEN_AGE_MS) {
    return null;
  }

  return payload;
}

export async function encryptJson(value, secret) {
  const key = await deriveAesKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(JSON.stringify(value))
  );

  return `${base64urlEncode(iv)}.${base64urlEncode(new Uint8Array(ciphertext))}`;
}

export async function decryptJson(value, secret) {
  const [ivPart, cipherPart] = value.split(".");
  if (!ivPart || !cipherPart) {
    return null;
  }

  const key = await deriveAesKey(secret);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64urlDecode(ivPart) },
    key,
    base64urlDecode(cipherPart)
  );

  return JSON.parse(decoder.decode(new Uint8Array(plaintext)));
}
