import { aiFeatureCosts, listAIFeatures } from "./ai-feature-config.mjs";

export const FEED_CATEGORIES = ["general", "tech", "science", "business", "entertainment"];
export const VISUAL_FEED_PAGE_SIZE_DEFAULT = 20;
export const VISUAL_FEED_PAGE_SIZE_MAX = 50;
export const VISUAL_FEED_SNAPSHOT_LIMIT = 100;
export const VISUAL_FEED_SNAPSHOT_KEY = "visual-feed:global:v1";
export const VISUAL_FEED_CACHE_TTL_SECONDS = 60;
export const MEDIA_MAX_QUEUE_RETRIES = 3;
export const MEDIA_DAILY_LIMIT_DEFAULT = 50;
export const MEDIA_PER_RUN_LIMIT_DEFAULT = 5;
export const MEDIA_MIN_SCORE_DEFAULT = 5;
export const MEDIA_FALAI_DAILY_LIMIT_DEFAULT = 10;

function intEnv(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}


function trimBaseUrl(value) {
  return value.replace(/\/+$/, "");
}

/**
 * Derive the canonical public API base URL from environment vars.
 * Falls back to PUBLIC_BASE_URL for compatibility with existing configs.
 */
export function publicApiBaseUrl(env) {
  return trimBaseUrl(env.PUBLIC_API_BASE_URL ?? env.PUBLIC_BASE_URL ?? "https://newsroll.invalid");
}

/**
 * Backward-compatible alias for older callers.
 */
export function publicBaseUrl(env) {
  return publicApiBaseUrl(env);
}

export function publicMediaUrlFor(env, mediaKey) {
  const normalizedKey = String(mediaKey ?? "").replace(/^\/+/, "");
  const mediaBase = env?.PUBLIC_MEDIA_BASE_URL ? trimBaseUrl(env.PUBLIC_MEDIA_BASE_URL) : null;
  if (mediaBase) {
    return `${mediaBase}/${normalizedKey}`;
  }
  return `${publicApiBaseUrl(env)}/media/${normalizedKey}`;
}

export function buildAppConfig(env) {
  return {
    visualFeed: {
      mode: "global",
      path: "/v1/visual-feed",
      defaultPageSize: intEnv(env?.VISUAL_FEED_PAGE_SIZE_DEFAULT, VISUAL_FEED_PAGE_SIZE_DEFAULT),
      maxPageSize: intEnv(env?.VISUAL_FEED_PAGE_SIZE_MAX, VISUAL_FEED_PAGE_SIZE_MAX)
    },
    supportsReadableMode: true,
    ai: {
      features: listAIFeatures()
    },
    credits: {
      enabled: true,
      currencyCode: "credit",
      costs: aiFeatureCosts(),
      proMonthlyCredits: 750,
      packs: [
        { id: "newsroll_credit_small", credits: 300 },
        { id: "newsroll_credit_medium", credits: 800 },
        { id: "newsroll_credit_large", credits: 2000 },
        { id: "newsroll_credit_ultra", credits: 5000 }
      ]
    }
  };
}
