import { getCachedAIResult } from "./db.mjs";
import { aiFeatureCosts } from "./ai-feature-config.mjs";
import { getSubscriberInfo, getCreditBalance, spendCredits } from "./revenuecat.mjs";
import * as log from "./log.mjs";

const CREDIT_COSTS = aiFeatureCosts();

export { CREDIT_COSTS };

export async function authorizeAIRequest(env, revenueCatAppUserId, action, { requireBalance = true } = {}) {
  const cost = CREDIT_COSTS[action];
  if (!cost) {
    return { error: "unknown_action" };
  }

  const subscriber = await getSubscriberInfo(env, revenueCatAppUserId);
  if (subscriber?.isPro == null) {
    log.warn({ event: "ai_billing_gate_denied", action, subscriberId: revenueCatAppUserId, reason: "subscription_status_unavailable" });
    return { error: "subscription_status_unavailable" };
  }
  if (!subscriber?.isPro) {
    log.warn({
      event: "ai_billing_gate_denied",
      action,
      subscriberId: revenueCatAppUserId,
      reason: "pro_required",
      entitlementIds: subscriber.entitlementIds,
      matchedEntitlementId: subscriber.matchedEntitlementId,
      entitlementSelection: subscriber.entitlementSelection,
      proExpiresAt: subscriber.proExpiresAt
    });
    return { error: "pro_required" };
  }

  if (!requireBalance) {
    return { proceed: true, cost };
  }

  return ensureAIRequestBalance(env, revenueCatAppUserId, action);
}

export async function ensureAIRequestBalance(env, revenueCatAppUserId, action) {
  const cost = CREDIT_COSTS[action];
  if (!cost) {
    return { error: "unknown_action" };
  }

  // Balance can drift independently from entitlement, so keep this check separate.
  const balance = await getCreditBalance(env, revenueCatAppUserId);
  if (balance == null) {
    log.warn({ event: "ai_billing_gate_denied", action, subscriberId: revenueCatAppUserId, reason: "credit_balance_unavailable" });
    return { error: "credit_balance_unavailable" };
  }
  if (balance < cost) {
    log.warn({ event: "ai_billing_gate_denied", action, subscriberId: revenueCatAppUserId, reason: "insufficient_credits", balance, required: cost });
    return { error: "insufficient_credits", balance, required: cost };
  }

  return { proceed: true, cost, balance };
}

export async function processAIRequest(env, revenueCatAppUserId, action, cacheKey) {
  const auth = await authorizeAIRequest(env, revenueCatAppUserId, action);
  if (!auth?.proceed) {
    return auth;
  }

  const cached = await getCachedAIResult(env, cacheKey);
  if (cached) {
    return { proceed: true, cached: true, result: cached.resultText, cost: auth.cost };
  }

  return { proceed: true, cached: false, cost: auth.cost };
}

export async function finalizeAIRequestCharge(env, revenueCatAppUserId, action, cacheKey, cost) {
  const idempotencyKey = `ai-charge:${revenueCatAppUserId}:${action}:${cacheKey}`;
  const spendResult = await spendCredits(env, revenueCatAppUserId, cost, idempotencyKey);

  if (!spendResult.success) {
    if (spendResult.reason === "insufficient_balance") {
      return { error: "insufficient_credits", balance: spendResult.detail?.balance, required: cost };
    }
    return { error: "credit_spend_failed" };
  }

  return { success: true, balance: spendResult.balance, cost };
}
