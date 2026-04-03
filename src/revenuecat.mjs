import * as log from "./log.mjs";

const CURRENCY_CODE = "credit";
const SUBSCRIBER_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Simple in-memory per-isolate cache for subscriber info
const subscriberCache = new Map();
const customerIdCache = new Map();

function hasRevenueCatV2Config(env) {
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

function isUuidLike(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function getCachedCustomerId(subscriberId) {
  const cached = customerIdCache.get(subscriberId);
  if (!cached) return null;
  if (Date.now() - cached.ts >= SUBSCRIBER_CACHE_TTL_MS) {
    customerIdCache.delete(subscriberId);
    return null;
  }
  return cached.value;
}

function cacheResolvedCustomerId(requestedSubscriberId, resolvedSubscriberId) {
  if (!requestedSubscriberId || !resolvedSubscriberId) return;
  const entry = { value: resolvedSubscriberId, ts: Date.now() };
  customerIdCache.set(requestedSubscriberId, entry);
  customerIdCache.set(resolvedSubscriberId, entry);
}

function candidateSubscriberIds(subscriberId) {
  const normalized = String(subscriberId ?? "").trim();
  if (!normalized) return [];

  const candidates = [];
  const push = (value) => {
    if (value && !candidates.includes(value)) {
      candidates.push(value);
    }
  };

  push(getCachedCustomerId(normalized));
  push(normalized);

  if (isUuidLike(normalized)) {
    push(normalized.toUpperCase());
    push(normalized.toLowerCase());
  }

  return candidates;
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

async function fetchRevenueCatCustomer(env, {
  operation,
  subscriberId,
  method = "GET",
  pathForSubscriberId,
  body,
  idempotencyKey
}) {
  const candidates = candidateSubscriberIds(subscriberId);
  let lastResponse = null;

  for (let index = 0; index < candidates.length; index += 1) {
    const candidateId = candidates[index];
    const response = await fetchRevenueCat(env, {
      operation,
      subscriberId: candidateId,
      method,
      path: pathForSubscriberId(candidateId),
      body,
      idempotencyKey
    });

    if (response.ok) {
      cacheResolvedCustomerId(subscriberId, candidateId);
      return { response, resolvedSubscriberId: candidateId };
    }

    lastResponse = response;
    if (response.status !== 404) {
      return { response, resolvedSubscriberId: candidateId };
    }

    const nextCandidateId = candidates[index + 1];
    if (nextCandidateId) {
      log.info({
        event: "rc_customer_alias_retry",
        operation,
        requestedSubscriberId: subscriberId,
        failedSubscriberId: candidateId,
        retrySubscriberId: nextCandidateId
      });
    }
  }

  return { response: lastResponse, resolvedSubscriberId: subscriberId };
}

function parseRevenueCatDate(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") return value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function encodeSubscriberId(subscriberId) {
  return encodeURIComponent(String(subscriberId ?? ""));
}

function buildSubscriberResult(raw, entitlements) {
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
      entitlementId: proEntitlement.entitlement_id,
      expiresAt: proEntitlement.expires_at
    });
  }

  return {
    raw,
    isPro: hasKnownExpiry ? isPro : null,
    entitlementIds: entitlements.map((entitlement) => entitlement.entitlement_id).filter(Boolean),
    proExpiresAt: proEntitlement?.expires_at ?? null,
    matchedEntitlementId: proEntitlement?.entitlement_id ?? null,
    entitlementSelection: selectedEntitlement?.selection ?? null
  };
}

function buildSubscriberResultFromV2(data) {
  const entitlements = data?.active_entitlements?.items
    ?? data?.customer?.active_entitlements?.items
    ?? [];
  return buildSubscriberResult(data, entitlements);
}

async function logSubscriberFetchFailure(response, subscriberId, hint) {
  const detail = await response.text().catch(() => "");
  log.warn({
    event: "rc_subscriber_fetch_fail",
    message: `rc_subscriber_fetch_fail: status=${response.status}`,
    subscriberId,
    status: response.status,
    detail: detail.slice(0, 300),
    hint
  });
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
  if (!hasRevenueCatV2Config(env)) {
    log.warn({
      event: "rc_config_missing",
      message: `rc_config_missing: REVENUECAT_SECRET_KEY=${Boolean(env.REVENUECAT_SECRET_KEY)} REVENUECAT_PROJECT_ID=${Boolean(env.REVENUECAT_PROJECT_ID)}`,
      subscriberId,
      hasSecretKey: Boolean(env.REVENUECAT_SECRET_KEY),
      hasProjectId: Boolean(env.REVENUECAT_PROJECT_ID)
    });
    return null;
  }

  const cacheKey = `sub:${subscriberId}`;
  const cached = subscriberCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < SUBSCRIBER_CACHE_TTL_MS) {
    log.info({ event: "rc_cache_hit", operation: "get_subscriber", subscriberId, cacheKey });
    return cached.data;
  }

  const { response, resolvedSubscriberId } = await fetchRevenueCatCustomer(env, {
    operation: "get_subscriber",
    subscriberId,
    pathForSubscriberId: (candidateId) => `/customers/${encodeSubscriberId(candidateId)}`
  });

  if (!response.ok) {
    await logSubscriberFetchFailure(
      response,
      resolvedSubscriberId,
      response.status === 401 ? "check REVENUECAT_SECRET_KEY" : response.status === 404 ? "check REVENUECAT_PROJECT_ID or subscriber not found" : undefined
    );
    return null;
  }

  const result = buildSubscriberResultFromV2(await response.json());
  const cacheEntry = { data: result, ts: Date.now() };
  subscriberCache.set(cacheKey, cacheEntry);
  if (resolvedSubscriberId && resolvedSubscriberId !== subscriberId) {
    subscriberCache.set(`sub:${resolvedSubscriberId}`, cacheEntry);
  }
  return result;
}

export async function getCreditBalance(env, subscriberId) {
  if (!hasRevenueCatV2Config(env)) {
    log.warn({ event: "rc_config_missing", subscriberId });
    return null;
  }

  const { response, resolvedSubscriberId } = await fetchRevenueCatCustomer(env, {
    operation: "get_balance",
    subscriberId,
    pathForSubscriberId: (candidateId) => `/customers/${encodeSubscriberId(candidateId)}/virtual_currencies`
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    log.warn({ event: "rc_balance_fetch_fail", subscriberId: resolvedSubscriberId, status: response.status, detail: detail.slice(0, 300) });
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
  if (!hasRevenueCatV2Config(env)) {
    log.warn({ event: "rc_config_missing", subscriberId, amount });
    return { success: false, reason: "api_unavailable" };
  }

  const { response, resolvedSubscriberId } = await fetchRevenueCatCustomer(env, {
    operation: "spend_credits",
    subscriberId,
    method: "POST",
    pathForSubscriberId: (candidateId) => `/customers/${encodeSubscriberId(candidateId)}/virtual_currencies/transactions`,
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
    log.warn({ event: "rc_spend_fail", subscriberId: resolvedSubscriberId, amount, status: response.status, detail: detail.slice(0, 300) });
    return { success: false, reason: "api_error" };
  }

  const data = await response.json();
  // Invalidate subscriber cache after spending
  subscriberCache.delete(`sub:${subscriberId}`);
  if (resolvedSubscriberId && resolvedSubscriberId !== subscriberId) {
    subscriberCache.delete(`sub:${resolvedSubscriberId}`);
  }

  // V2 response: { object: "list", items: [{ currency_code, balance, ... }] }
  const creditItem = (data?.items ?? []).find(
    (vc) => vc.currency_code === CURRENCY_CODE
  );
  const balance = creditItem?.balance ?? null;
  return { success: true, balance };
}

export { CURRENCY_CODE };
