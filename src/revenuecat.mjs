import * as log from "./log.mjs";

const CURRENCY_CODE = "credit";
const SUBSCRIBER_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Simple in-memory per-isolate cache for subscriber info
const subscriberCache = new Map();

function hasRevenueCatConfig(env) {
  return Boolean(env.REVENUECAT_SECRET_KEY && env.REVENUECAT_PROJECT_ID);
}

function rcHeaders(env) {
  return {
    authorization: `Bearer ${env.REVENUECAT_SECRET_KEY}`,
    "content-type": "application/json",
    accept: "application/json"
  };
}

function rcBaseUrl(env) {
  return `https://api.revenuecat.com/v2/projects/${env.REVENUECAT_PROJECT_ID}`;
}

function truncateForLog(value, limit = 300) {
  if (value == null) {
    return undefined;
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.slice(0, limit);
}

async function fetchRevenueCat(env, {
  operation,
  subscriberId,
  method = "GET",
  path,
  body,
  idempotencyKey
}) {
  const startedAt = Date.now();
  const url = `${rcBaseUrl(env)}${path}`;

  log.info({
    event: "rc_request",
    operation,
    subscriberId,
    method,
    path,
    requestSnippet: truncateForLog(body)
  });

  try {
    const response = await fetch(url, {
      method,
      headers: {
        ...rcHeaders(env),
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {})
      },
      body: body == null ? undefined : JSON.stringify(body)
    });

    const responseSnippet = await response.clone().text()
      .then((text) => truncateForLog(text))
      .catch(() => undefined);

    const logFn = response.ok ? log.info : log.warn;
    logFn({
      event: "rc_response",
      operation,
      subscriberId,
      method,
      path,
      status: response.status,
      durationMs: Date.now() - startedAt,
      responseSnippet
    });

    return response;
  } catch (error) {
    log.error({
      event: "rc_request_error",
      operation,
      subscriberId,
      method,
      path,
      durationMs: Date.now() - startedAt,
      ...log.fmtError(error)
    });
    throw error;
  }
}

function parseRevenueCatDate(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") return value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function selectActiveEntitlement(entitlements) {
  if (!Array.isArray(entitlements) || entitlements.length === 0) {
    return null;
  }

  const explicitProEntitlement = entitlements.find(
    (entitlement) => entitlement.entitlement_id === "pro" || entitlement.entitlement_id?.endsWith("pro")
  );
  if (explicitProEntitlement) {
    return { entitlement: explicitProEntitlement, selection: "explicit_pro" };
  }

  const fallbackEntitlement = entitlements.find((entitlement) => typeof entitlement?.entitlement_id === "string");
  if (fallbackEntitlement) {
    return { entitlement: fallbackEntitlement, selection: "first_active" };
  }

  return null;
}

export async function getSubscriberInfo(env, subscriberId) {
  if (!hasRevenueCatConfig(env)) {
    log.warn({ event: "rc_config_missing", subscriberId });
    return null;
  }

  const cacheKey = `sub:${subscriberId}`;
  const cached = subscriberCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < SUBSCRIBER_CACHE_TTL_MS) {
    log.info({ event: "rc_cache_hit", operation: "get_subscriber", subscriberId, cacheKey });
    return cached.data;
  }

  const response = await fetchRevenueCat(env, {
    operation: "get_subscriber",
    subscriberId,
    path: `/customers/${subscriberId}`
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    log.warn({ event: "rc_subscriber_fetch_fail", subscriberId, status: response.status, detail: detail.slice(0, 300) });
    return null;
  }

  const data = await response.json();

  // V2 response: active_entitlements is a list object with items array
  // Each item has { object, entitlement_id, expires_at }
  const entitlements = data?.active_entitlements?.items
    ?? data?.customer?.active_entitlements?.items
    ?? [];
  const selectedEntitlement = selectActiveEntitlement(entitlements);
  const proEntitlement = selectedEntitlement?.entitlement ?? null;
  const expiresAtMs = parseRevenueCatDate(proEntitlement?.expires_at);
  const hasLifetimeAccess = proEntitlement != null && (proEntitlement.expires_at == null || proEntitlement.expires_at === "");
  const hasKnownExpiry = proEntitlement == null || hasLifetimeAccess || expiresAtMs != null;
  const isPro = proEntitlement != null && (
    hasLifetimeAccess ||
    expiresAtMs > Date.now()
  );

  if (proEntitlement && !hasKnownExpiry) {
    log.warn({
      event: "rc_entitlement_expiry_invalid",
      subscriberId,
      entitlementId: proEntitlement.entitlement_id,
      expiresAt: proEntitlement.expires_at
    });
  }

  const result = {
    raw: data,
    isPro: hasKnownExpiry ? isPro : null,
    entitlementIds: entitlements.map((entitlement) => entitlement.entitlement_id).filter(Boolean),
    proExpiresAt: proEntitlement?.expires_at ?? null,
    matchedEntitlementId: proEntitlement?.entitlement_id ?? null,
    entitlementSelection: selectedEntitlement?.selection ?? null
  };
  subscriberCache.set(cacheKey, { data: result, ts: Date.now() });
  return result;
}

export async function getCreditBalance(env, subscriberId) {
  if (!hasRevenueCatConfig(env)) {
    log.warn({ event: "rc_config_missing", subscriberId });
    return null;
  }

  const response = await fetchRevenueCat(env, {
    operation: "get_balance",
    subscriberId,
    path: `/customers/${subscriberId}/virtual_currencies`
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    log.warn({ event: "rc_balance_fetch_fail", subscriberId, status: response.status, detail: detail.slice(0, 300) });
    return null;
  }

  const data = await response.json();
  // V2 response: { object: "list", items: [{ object: "virtual_currency_balance", currency_code, balance, ... }] }
  const creditCurrency = (data?.items ?? []).find(
    (vc) => vc.currency_code === CURRENCY_CODE
  );
  return creditCurrency?.balance ?? 0;
}

export async function spendCredits(env, subscriberId, amount, idempotencyKey) {
  if (!hasRevenueCatConfig(env)) {
    log.warn({ event: "rc_config_missing", subscriberId, amount });
    return { success: false, reason: "api_unavailable" };
  }

  const response = await fetchRevenueCat(env, {
    operation: "spend_credits",
    subscriberId,
    method: "POST",
    path: `/customers/${subscriberId}/virtual_currencies/transactions`,
    idempotencyKey,
    body: {
      adjustments: { [CURRENCY_CODE]: -amount }
    }
  });

  if (response.status === 422) {
    const detail = await response.json().catch(() => ({}));
    return { success: false, reason: "insufficient_balance", detail };
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    log.warn({ event: "rc_spend_fail", subscriberId, amount, status: response.status, detail: detail.slice(0, 300) });
    return { success: false, reason: "api_error" };
  }

  const data = await response.json();
  // Invalidate subscriber cache after spending
  subscriberCache.delete(`sub:${subscriberId}`);

  // V2 response: { object: "list", items: [{ currency_code, balance, ... }] }
  const creditItem = (data?.items ?? []).find(
    (vc) => vc.currency_code === CURRENCY_CODE
  );
  const balance = creditItem?.balance ?? null;
  return { success: true, balance };
}

export { CURRENCY_CODE };
