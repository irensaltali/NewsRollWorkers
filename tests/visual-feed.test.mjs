import test from "node:test";
import assert from "node:assert/strict";

import { VISUAL_FEED_CACHE_TTL_SECONDS } from "../src/config.mjs";
import { publishReadyStoryDirect } from "../src/global-visual-feed-coordinator.mjs";
import { buildVisualFeedResponse, writeVisualFeedSnapshot } from "../src/visual-feed.mjs";

function readyRow(storyId = 99999999) {
  return {
    storyId,
    publishSequence: 3,
    sourceEndpoint: "front",
    publishedAt: "2026-03-12T12:00:00.000Z",
    mediaUrl: "https://cdn.example.com/story.jpg",
    sourceUrl: `https://example.com/articles/${storyId}`,
    readableUrl: `https://newsroll.invalid/v1/stories/${storyId}/article`,
    mediaStatus: "ready",
    summary: "A short summary explains what changed and why it matters."
  };
}

test("writeVisualFeedSnapshot uses a Cloudflare-compatible KV ttl", async () => {
  let options = null;

  await writeVisualFeedSnapshot(
    {
      VISUAL_FEED_CACHE: {
        async put(_key, _value, nextOptions) {
          options = nextOptions;
        }
      }
    },
    [readyRow()]
  );

  assert.deepEqual(options, { expirationTtl: VISUAL_FEED_CACHE_TTL_SECONDS });
  assert.equal(options.expirationTtl >= 60, true);
});

test("writeVisualFeedSnapshot does not throw when the cache write fails", async () => {
  await assert.doesNotReject(() =>
    writeVisualFeedSnapshot(
      {
        VISUAL_FEED_CACHE: {
          async put() {
            throw new Error("kv unavailable");
          }
        }
      },
      [readyRow()]
    )
  );
});

test("publishReadyStoryDirect still succeeds when snapshot cache writes fail", async () => {
  const result = await publishReadyStoryDirect(
    {
      PUBLIC_BASE_URL: "https://newsroll.invalid",
      VISUAL_FEED_CACHE: {
        async get() {
          return null;
        },
        async put() {
          throw new Error("kv unavailable");
        }
      }
    },
    readyRow()
  );

  assert.equal(result.ok, true);
  assert.equal(result.published, true);
  assert.equal(result.publishSequence > 0, true);
});

test("buildVisualFeedResponse preserves locked manifest flags", () => {
  const response = buildVisualFeedResponse(
    { PUBLIC_BASE_URL: "https://newsroll.invalid" },
    [
      { ...readyRow(1), isLocked: false },
      { ...readyRow(2), storyId: 2, publishSequence: 2, isLocked: true }
    ],
    null,
    10
  );

  assert.equal(response.items[0].isLocked, false);
  assert.equal(response.items[1].isLocked, true);
  assert.equal(response.items[0].summary, "A short summary explains what changed and why it matters.");
});
