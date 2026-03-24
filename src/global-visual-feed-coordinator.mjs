import {
  getLatestPublishedVisualFeedSnapshot,
  getMaxPublishedVisualFeedSequence,
  isStoryPublished,
  publishReadyStory
} from "./d1.mjs";
import { error, json, readJson } from "./http.mjs";
import * as log from "./log.mjs";
import {
  makePublishedVisualFeedRow,
  mergeVisualFeedSnapshot,
  readVisualFeedSnapshot,
  writeVisualFeedSnapshot
} from "./visual-feed.mjs";

const COORDINATOR_NAME = "global-feed";
const COORDINATOR_URL = "https://global-visual-feed-coordinator.internal";

function validatePayload(payload) {
  if (!payload?.storyId || !payload?.sourceEndpoint || !payload?.mediaUrl || payload?.mediaStatus !== "ready") {
    return "storyId, sourceEndpoint, mediaUrl, and mediaStatus=ready are required";
  }
  return null;
}

async function insertPublishedEntry(env, nextSequence, payload) {
  if (await isStoryPublished(env, payload.storyId)) {
    return { published: false, reason: "already_published" };
  }

  const publishSequence = await nextSequence();
  const publishedAt = payload.publishedAt ?? new Date().toISOString();
  const inserted = await publishReadyStory(env, {
    storyId: payload.storyId,
    publishSequence,
    sourceEndpoint: payload.sourceEndpoint,
    publishedAt
  });

  if (!inserted) {
    return { published: false, reason: "already_published" };
  }

  return { published: true, publishSequence, publishedAt };
}

async function updateSnapshot(env, payload, publishSequence, publishedAt) {
  const row = makePublishedVisualFeedRow(env, {
    ...payload,
    publishSequence,
    publishedAt
  });
  const currentSnapshot =
    (await readVisualFeedSnapshot(env)) ??
    (await getLatestPublishedVisualFeedSnapshot(env));
  const snapshot = mergeVisualFeedSnapshot(currentSnapshot ?? [], row);
  await writeVisualFeedSnapshot(env, snapshot);
}

export async function publishReadyStoryDirect(env, payload) {
  const validationError = validatePayload(payload);
  if (validationError) {
    return { ok: false, status: 422, error: validationError };
  }

  let nextSequence = await getMaxPublishedVisualFeedSequence(env);
  const result = await insertPublishedEntry(
    env,
    async () => {
      nextSequence += 1;
      return nextSequence;
    },
    payload
  );

  if (!result.published) {
    return { ok: true, published: false, reason: result.reason };
  }

  await updateSnapshot(env, payload, result.publishSequence, result.publishedAt);

  log.info({
    event: "visual_feed_publish_ok",
    storyId: payload.storyId,
    sourceEndpoint: payload.sourceEndpoint,
    publishSequence: result.publishSequence
  });

  return { ok: true, published: true, publishSequence: result.publishSequence, publishedAt: result.publishedAt };
}

export async function publishReadyStoryViaCoordinator(env, payload) {
  if (!env?.GLOBAL_VISUAL_FEED_COORDINATOR?.idFromName) {
    log.warn({ event: "visual_feed_publish_direct_fallback", storyId: payload?.storyId });
    return publishReadyStoryDirect(env, payload);
  }

  const stub = env.GLOBAL_VISUAL_FEED_COORDINATOR.get(
    env.GLOBAL_VISUAL_FEED_COORDINATOR.idFromName(COORDINATOR_NAME)
  );
  const response = await stub.fetch(`${COORDINATOR_URL}/publish`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Coordinator publish failed: HTTP ${response.status}${detail ? ` ${detail}` : ""}`);
  }

  return response.json();
}

export class GlobalVisualFeedCoordinator {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async nextSequence() {
    let current = await this.ctx.storage.get("nextPublishSequence");
    if (!Number.isInteger(current)) {
      current = await getMaxPublishedVisualFeedSequence(this.env);
    }
    const next = current + 1;
    await this.ctx.storage.put("nextPublishSequence", next);
    return next;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/publish") {
      const payload = (await readJson(request)) ?? {};
      const validationError = validatePayload(payload);
      if (validationError) {
        return error(validationError, 422);
      }

      const result = await insertPublishedEntry(this.env, () => this.nextSequence(), payload);
      if (!result.published) {
        return json({ ok: true, published: false, reason: result.reason });
      }

      // Snapshot update runs inside the DO — single-threaded, no concurrent merge races
      await updateSnapshot(this.env, payload, result.publishSequence, result.publishedAt);

      log.info({
        event: "visual_feed_publish_ok",
        storyId: payload.storyId,
        sourceEndpoint: payload.sourceEndpoint,
        publishSequence: result.publishSequence
      });

      return json({
        ok: true,
        published: true,
        publishSequence: result.publishSequence,
        publishedAt: result.publishedAt
      });
    }

    return error("Route not found", 404);
  }
}
