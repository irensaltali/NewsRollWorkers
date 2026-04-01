import {
  createAdminAuditLog,
  createAdminSession,
  deleteAdminSession,
  getAdminSessionByHash,
  getAdminUserByUsername,
  touchAdminSession,
  upsertAdminUser
} from "./db.mjs";

const SESSION_COOKIE = "hr_admin_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const PBKDF2_ITERATIONS = 100_000;

function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value) {
  const base64 = String(value ?? "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4 || 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function derivePasswordHash(password, salt) {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: decodeBase64Url(salt),
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256"
    },
    keyMaterial,
    256
  );

  return encodeBase64Url(new Uint8Array(bits));
}

export async function hashAdminPassword(password, salt = null) {
  const resolvedSalt = salt ?? encodeBase64Url(crypto.getRandomValues(new Uint8Array(16)));
  const passwordHash = await derivePasswordHash(password, resolvedSalt);
  return {
    passwordSalt: resolvedSalt,
    passwordHash
  };
}

function timingSafeEqual(a, b) {
  if (a.byteLength !== b.byteLength) {
    return false;
  }
  // crypto.subtle.timingSafeEqual is available in Cloudflare Workers
  if (typeof crypto.subtle?.timingSafeEqual === "function") {
    return crypto.subtle.timingSafeEqual(a, b);
  }
  // Fallback: constant-time comparison via XOR accumulator
  let result = 0;
  for (let i = 0; i < a.byteLength; i++) {
    result |= a[i] ^ b[i];
  }
  return result === 0;
}

export async function verifyAdminPassword(password, user) {
  if (!user?.passwordSalt || !user?.passwordHash) {
    return false;
  }

  const derived = await derivePasswordHash(password, user.passwordSalt);
  const a = new TextEncoder().encode(derived);
  const b = new TextEncoder().encode(user.passwordHash);
  return timingSafeEqual(a, b);
}

function parseCookies(request) {
  const header = request.headers.get("cookie") ?? "";
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [name, ...rest] = part.split("=");
        return [name, decodeURIComponent(rest.join("="))];
      })
  );
}

function sessionCookieValue(request) {
  return parseCookies(request)[SESSION_COOKIE] ?? null;
}

function cookieHeader(token, { expiresAt, clear = false } = {}) {
  const attributes = [
    `${SESSION_COOKIE}=${clear ? "" : encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=None",
    "Secure"
  ];

  if (clear) {
    attributes.push("Max-Age=0");
  } else {
    attributes.push(`Expires=${new Date(expiresAt).toUTCString()}`);
  }

  return attributes.join("; ");
}

export async function syncAdminSeedUser(env) {
  const username = String(env.ADMIN_USERNAME ?? "").trim();
  const password = String(env.ADMIN_PASSWORD ?? "").trim();
  if (!username || !password) {
    return null;
  }

  const existing = await getAdminUserByUsername(env, username);
  const { passwordSalt, passwordHash } = await hashAdminPassword(password, existing?.passwordSalt ?? null);
  const user = await upsertAdminUser(env, {
    username,
    passwordSalt,
    passwordHash,
    active: true
  });

  await createAdminAuditLog(env, {
    userId: user?.id ?? null,
    username,
    action: "admin_user_synced",
    targetType: "admin_user",
    targetId: username,
    detailsJson: JSON.stringify({ source: "env_seed" })
  });

  return user;
}

export async function createAuthenticatedAdminSession(env, user, accessIdentity) {
  const rawToken = crypto.randomUUID() + crypto.randomUUID();
  const sessionHash = await sha256Hex(rawToken);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

  await createAdminSession(env, {
    id: crypto.randomUUID(),
    userId: user.id,
    sessionHash,
    accessEmail: accessIdentity?.email ?? null,
    accessSubject: accessIdentity?.subject ?? null,
    expiresAt
  });

  await createAdminAuditLog(env, {
    userId: user.id,
    username: user.username,
    action: "admin_login",
    targetType: "session",
    targetId: sessionHash,
    detailsJson: JSON.stringify({ accessEmail: accessIdentity?.email ?? null })
  });

  return {
    token: rawToken,
    expiresAt
  };
}

export async function getAuthenticatedAdmin(request, env) {
  const token = sessionCookieValue(request);
  if (!token) {
    return null;
  }

  const sessionHash = await sha256Hex(token);
  const session = await getAdminSessionByHash(env, sessionHash);
  if (!session || Number(session.userActive ?? 0) !== 1) {
    return null;
  }

  if (Date.parse(session.expiresAt) <= Date.now()) {
    await deleteAdminSession(env, sessionHash);
    return null;
  }

  await touchAdminSession(env, sessionHash);
  return session;
}

export async function destroyAuthenticatedAdminSession(request, env) {
  const token = sessionCookieValue(request);
  if (!token) {
    return;
  }

  const sessionHash = await sha256Hex(token);
  const session = await getAdminSessionByHash(env, sessionHash);
  await deleteAdminSession(env, sessionHash);

  if (session) {
    await createAdminAuditLog(env, {
      userId: session.userId,
      username: session.username,
      action: "admin_logout",
      targetType: "session",
      targetId: session.id
    });
  }
}

export function attachAdminSessionCookie(response, session) {
  const headers = new Headers(response.headers);
  headers.append("set-cookie", cookieHeader(session.token, { expiresAt: session.expiresAt }));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

export function clearAdminSessionCookie(response) {
  const headers = new Headers(response.headers);
  headers.append("set-cookie", cookieHeader("", { clear: true }));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
