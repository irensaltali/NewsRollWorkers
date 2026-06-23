import {
  VISUAL_FEED_CACHE_TTL_SECONDS,
  VISUAL_FEED_PAGE_SIZE_DEFAULT,
  VISUAL_FEED_PAGE_SIZE_MAX,
  VISUAL_FEED_SNAPSHOT_KEY,
  VISUAL_FEED_SNAPSHOT_LIMIT,
  publicApiBaseUrl
} from "./config.mjs";
import * as log from "./log.mjs";

export function readableUrlFor(env, storyId) {
  return `${publicApiBaseUrl(env)}/v1/stories/${storyId}/article`;
}

export function parseVisualFeedCursor(value) {
  if (value == null || value === "") {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function parseVisualFeedLimit(env, value) {
  const fallback = Number.parseInt(env?.VISUAL_FEED_PAGE_SIZE_DEFAULT ?? `${VISUAL_FEED_PAGE_SIZE_DEFAULT}`, 10);
  const max = Number.parseInt(env?.VISUAL_FEED_PAGE_SIZE_MAX ?? `${VISUAL_FEED_PAGE_SIZE_MAX}`, 10);
  const parsed = Number.parseInt(value ?? "", 10);
  const candidate = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  return Math.min(candidate, max);
}

export function makePublishedVisualFeedRow(env, payload) {
  return {
    storyId: payload.storyId,
    publishSequence: payload.publishSequence,
    sourceEndpoint: payload.sourceEndpoint,
    publishedAt: payload.publishedAt,
    mediaUrl: payload.mediaUrl,
    sourceUrl: payload.sourceUrl ?? null,
    mediaStatus: payload.mediaStatus ?? "ready",
    readableUrl: payload.readableUrl ?? readableUrlFor(env, payload.storyId),
    headline: payload.headline ?? null,
    summary: payload.summary ?? null
  };
}

export function toVisualFeedItem(env, row) {
  return {
    storyId: row.storyId,
    rank: row.publishSequence,
    publishSequence: row.publishSequence,
    sourceEndpoint: row.sourceEndpoint,
    publishedAt: row.publishedAt,
    mediaUrl: row.mediaUrl ?? null,
    sourceUrl: row.sourceUrl ?? null,
    readableUrl: row.readableUrl ?? readableUrlFor(env, row.storyId),
    mediaStatus: row.mediaStatus ?? "ready",
    headline: row.headline ?? null,
    summary: row.summary ?? null,
    isLocked: row.isLocked ?? null
  };
}

export function buildVisualFeedResponse(env, rows, cursor, limit) {
  const items = rows.slice(0, limit).map((row) => toVisualFeedItem(env, row));
  return {
    cursor: cursor ?? null,
    nextCursor: items.length === limit ? items.at(-1)?.publishSequence ?? null : null,
    items
  };
}

function normalizeSnapshot(raw) {
  if (!raw) {
    return null;
  }

  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  const items = Array.isArray(parsed) ? parsed : parsed?.items;
  if (!Array.isArray(items)) {
    return null;
  }

  const hasCompatibleShape = items.every((item) =>
    item &&
    typeof item === "object" &&
    Object.prototype.hasOwnProperty.call(item, "headline") &&
    Object.prototype.hasOwnProperty.call(item, "summary")
  );

  return hasCompatibleShape ? items : null;
}

export async function readVisualFeedSnapshot(env) {
  if (!env?.VISUAL_FEED_CACHE?.get) {
    return null;
  }

  const raw = await env.VISUAL_FEED_CACHE.get(VISUAL_FEED_SNAPSHOT_KEY);
  return normalizeSnapshot(raw);
}

export async function writeVisualFeedSnapshot(env, rows) {
  if (!env?.VISUAL_FEED_CACHE?.put) {
    return;
  }

  const items = rows.slice(0, VISUAL_FEED_SNAPSHOT_LIMIT);

  try {
    await env.VISUAL_FEED_CACHE.put(
      VISUAL_FEED_SNAPSHOT_KEY,
      JSON.stringify({
        version: 1,
        items
      }),
      { expirationTtl: VISUAL_FEED_CACHE_TTL_SECONDS }
    );
  } catch (err) {
    log.error({
      event: "visual_feed_snapshot_cache_write_fail",
      cacheKey: VISUAL_FEED_SNAPSHOT_KEY,
      snapshotSize: items.length,
      ttlSeconds: VISUAL_FEED_CACHE_TTL_SECONDS,
      ...log.fmtError(err)
    });
  }
}

export function mergeVisualFeedSnapshot(rows, newRow, maxItems = VISUAL_FEED_SNAPSHOT_LIMIT) {
  return [newRow, ...rows.filter((row) => row.storyId !== newRow.storyId)]
    .sort((left, right) => right.publishSequence - left.publishSequence)
    .slice(0, maxItems);
}
