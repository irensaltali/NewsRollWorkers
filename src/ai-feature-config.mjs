import { AI_ACTIONS } from "./ai-actions.mjs";

function cacheTtlSecondsFor(key) {
  const ttlMs = AI_ACTIONS[key]?.cacheTtlMs;
  return typeof ttlMs === "number" && ttlMs > 0 ? Math.floor(ttlMs / 1000) : null;
}

const AI_FEATURES = Object.freeze([
  Object.freeze({
    key: "summary",
    title: "Summarize",
    description: "Generate a concise article summary.",
    routePath: "/v1/ai/summary",
    promptKey: "summary",
    enabled: true,
    requiresPro: true,
    creditCost: AI_ACTIONS.summary.cost,
    usesStory: true,
    usesArticleText: true,
    usesComments: false,
    usesTargetLanguage: false,
    cacheTtlSeconds: cacheTtlSecondsFor("summary")
  }),
  Object.freeze({
    key: "translation",
    title: "Translate",
    description: "Translate the article and HN comments into a target language.",
    routePath: "/v1/ai/translate",
    promptKey: "translation",
    enabled: true,
    requiresPro: true,
    creditCost: AI_ACTIONS.translation.cost,
    usesStory: true,
    usesArticleText: true,
    usesComments: true,
    usesTargetLanguage: true,
    cacheTtlSeconds: cacheTtlSecondsFor("translation")
  }),
  Object.freeze({
    key: "explain_simple",
    title: "Explain",
    description: "Explain the article in simple terms.",
    routePath: "/v1/ai/explain",
    promptKey: "explain_simple",
    enabled: true,
    requiresPro: true,
    creditCost: AI_ACTIONS.explain_simple.cost,
    usesStory: true,
    usesArticleText: true,
    usesComments: false,
    usesTargetLanguage: false,
    cacheTtlSeconds: cacheTtlSecondsFor("explain_simple"),
    explainLevel: "simple"
  }),
  Object.freeze({
    key: "explain_technical",
    title: "Explain",
    description: "Explain the article with technical depth.",
    routePath: "/v1/ai/explain",
    promptKey: "explain_technical",
    enabled: true,
    requiresPro: true,
    creditCost: AI_ACTIONS.explain_technical.cost,
    usesStory: true,
    usesArticleText: true,
    usesComments: false,
    usesTargetLanguage: false,
    cacheTtlSeconds: cacheTtlSecondsFor("explain_technical"),
    explainLevel: "technical"
  })
]);

export function listAIFeatures() {
  return AI_FEATURES;
}

export function getAIFeatureConfig(key) {
  return AI_FEATURES.find((feature) => feature.key === key) ?? null;
}

export function aiFeatureCosts() {
  return Object.freeze(
    Object.fromEntries(AI_FEATURES.map((feature) => [feature.key, feature.creditCost]))
  );
}
