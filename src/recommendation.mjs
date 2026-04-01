import * as log from "./log.mjs";
import * as shaped from "./shaped.mjs";
import { getUserProfile, getRecommendationCandidates, getSeenStoryIds } from "./db.mjs";
import { FOR_YOU_MIN_EVENTS_DEFAULT } from "./config.mjs";

export const SCORE_WEIGHTS = {
  topic: 0.35,
  engagement: 0.20,
  quality: 0.15,
  freshness: 0.15,
  endpoint: 0.10,
  exploration: 0.05
};

export function getWeights(env) {
  return {
    topic: parseFloat(env?.SCORE_W_TOPIC ?? SCORE_WEIGHTS.topic),
    engagement: parseFloat(env?.SCORE_W_ENGAGEMENT ?? SCORE_WEIGHTS.engagement),
    quality: parseFloat(env?.SCORE_W_QUALITY ?? SCORE_WEIGHTS.quality),
    freshness: parseFloat(env?.SCORE_W_FRESHNESS ?? SCORE_WEIGHTS.freshness),
    endpoint: parseFloat(env?.SCORE_W_ENDPOINT ?? SCORE_WEIGHTS.endpoint),
    exploration: parseFloat(env?.SCORE_W_EXPLORATION ?? SCORE_WEIGHTS.exploration)
  };
}

export function encodeCursor(data) {
  return btoa(JSON.stringify(data)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const padded = cursor.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

function topicMatchScore(userTopics, storyTopics) {
  if (!userTopics || !storyTopics || storyTopics.length === 0) return 0;

  let dotProduct = 0;
  let userMag = 0;
  let storyMag = 0;

  const storySet = new Set(storyTopics);
  const allTopics = new Set([...Object.keys(userTopics), ...storyTopics]);

  for (const topic of allTopics) {
    const uScore = userTopics[topic] ?? 0;
    const sScore = storySet.has(topic) ? 1.0 : 0;
    dotProduct += uScore * sScore;
    userMag += uScore * uScore;
    storyMag += sScore * sScore;
  }

  const magnitude = Math.sqrt(userMag) * Math.sqrt(storyMag);
  return magnitude > 0 ? dotProduct / magnitude : 0;
}

function expectedEngagement(story) {
  const impressions = story.impressionCount ?? 0;
  const engagements = story.engagementCount ?? 0;
  if (impressions < 5) return 0.5;
  return engagements / impressions;
}

export function scoreStory(story, profile, weights) {
  let storyTopics;
  try {
    storyTopics = typeof story.topics === "string" ? JSON.parse(story.topics) : story.topics;
  } catch {
    storyTopics = [];
  }

  let userTopics;
  try {
    userTopics = typeof profile.topicScores === "string" ? JSON.parse(profile.topicScores) : profile.topicScores;
  } catch {
    userTopics = {};
  }

  let userEndpoints;
  try {
    userEndpoints = typeof profile.endpointScores === "string" ? JSON.parse(profile.endpointScores) : profile.endpointScores;
  } catch {
    userEndpoints = {};
  }

  const topicMatch = topicMatchScore(userTopics, storyTopics);
  const engagement = expectedEngagement(story);
  const quality = story.qualityScore ?? 0.5;
  const freshness = story.noveltyScore ?? 0.5;
  const endpointMatch = userEndpoints[story.sourceEndpoint] ?? 0;
  const exploration = Math.random();

  return (
    weights.topic * topicMatch +
    weights.engagement * engagement +
    weights.quality * quality +
    weights.freshness * freshness +
    weights.endpoint * endpointMatch +
    weights.exploration * exploration
  );
}

export function rerank(scoredItems) {
  const result = [];
  let consecutiveEndpoint = 0;
  let consecutiveTopic = 0;
  let lastEndpoint = null;
  let lastPrimaryTopic = null;

  const sorted = [...scoredItems].sort((a, b) => b.score - a.score);
  const deferred = [];

  for (const item of sorted) {
    let storyTopics;
    try {
      storyTopics = typeof item.topics === "string" ? JSON.parse(item.topics) : item.topics;
    } catch {
      storyTopics = [];
    }

    const primaryTopic = storyTopics[0] ?? null;
    const sameEndpoint = item.sourceEndpoint === lastEndpoint;
    const sameTopic = primaryTopic && primaryTopic === lastPrimaryTopic;

    if (sameEndpoint) consecutiveEndpoint++;
    else consecutiveEndpoint = 1;

    if (sameTopic) consecutiveTopic++;
    else consecutiveTopic = 1;

    if (consecutiveEndpoint > 2 || consecutiveTopic > 3) {
      deferred.push(item);
      continue;
    }

    result.push(item);
    lastEndpoint = item.sourceEndpoint;
    lastPrimaryTopic = primaryTopic;
  }

  result.push(...deferred);
  return result;
}

function injectFreshStory(items, allCandidates) {
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
  const resultIds = new Set(items.map((i) => i.storyId));

  const freshStory = allCandidates.find((c) => {
    if (resultIds.has(c.storyId)) return false;
    const publishTime = new Date(c.publishedAt).getTime();
    return publishTime > twoHoursAgo;
  });

  if (freshStory) {
    items.splice(1, 0, { ...freshStory, score: Infinity });
  }

  return items;
}

export async function generateRecommendedFeed(env, userId, { cursor: cursorParam, limit = 20 } = {}) {
  const start = Date.now();
  const weights = getWeights(env);
  const minQualifiedInteractions = Math.max(
    Number.parseInt(env?.FOR_YOU_MIN_EVENTS ?? `${FOR_YOU_MIN_EVENTS_DEFAULT}`, 10) || FOR_YOU_MIN_EVENTS_DEFAULT,
    1
  );

  const profile = userId ? await getUserProfile(env, userId) : null;
  const qualifiedInteractions = profile?.totalEngagements ?? 0;

  const allCandidates = await getRecommendationCandidates(env);
  if (allCandidates.length === 0) {
    log.info({ event: "cold_start_fallback", userId, reason: "no_candidates" });
    return { coldStart: true };
  }

  const seenIds = new Set(await getSeenStoryIds(env, userId));

  const cursorData = decodeCursor(cursorParam);
  const previouslySent = new Set(cursorData?.seen ?? []);

  const unseenCandidates = allCandidates.filter(
    (c) => !seenIds.has(c.storyId) && !previouslySent.has(c.storyId)
  );

  const maxCursorIds = 60;

  function buildResult(page, eventName) {
    const allSentIds = [...previouslySent, ...page.map((i) => i.storyId)];
    const nextCursorData = {
      seen: allSentIds.slice(-maxCursorIds),
      page: (cursorData?.page ?? 0) + 1
    };
    log.info({
      event: eventName,
      userId,
      candidatePoolSize: allCandidates.length,
      unseenCount: unseenCandidates.length,
      pageSize: page.length,
      scoringDurationMs: Date.now() - start
    });
    return {
      coldStart: false,
      items: page,
      nextCursor: page.length > 0 ? encodeCursor(nextCursorData) : null
    };
  }

  // Try Shaped ranking when configured and the user has enough qualified signals.
  if (env.SHAPED_API_KEY && qualifiedInteractions >= minQualifiedInteractions) {
    const candidateIds = unseenCandidates.map((c) => String(c.storyId));
    const rankedIds = await shaped.rankItems(env, userId, candidateIds);
    if (rankedIds.length > 0) {
      const candidateMap = new Map(unseenCandidates.map((c) => [String(c.storyId), c]));
      let shapedItems = rankedIds.map((id) => candidateMap.get(id)).filter(Boolean);
      shapedItems = injectFreshStory(shapedItems, allCandidates);
      return buildResult(shapedItems.slice(0, limit), "shaped_rank_served");
    }
    log.info({ event: "shaped_rank_fallback", userId, reason: "empty_response" });
  }

  // Local scoring fallback
  const scored = unseenCandidates.map((candidate) => ({
    ...candidate,
    score: scoreStory(candidate, profile ?? { topicScores: {}, endpointScores: {} }, weights)
  }));

  let ranked = rerank(scored);
  ranked = injectFreshStory(ranked, allCandidates);

  return buildResult(
    ranked.slice(0, limit),
    qualifiedInteractions >= minQualifiedInteractions ? "recommendation_served" : "recommendation_served_local_fallback"
  );
}
