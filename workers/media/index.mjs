import { ingestStories, mediaPerRunLimit, processMediaMessage } from "../../src/media-pipeline.mjs";
import { FEED_CATEGORIES } from "../../src/config.mjs";
import { GlobalVisualFeedCoordinator } from "../../src/global-visual-feed-coordinator.mjs";
import { enrichPublishedStory } from "../../src/enrichment.mjs";
import { aggregateStaleProfiles } from "../../src/profile-aggregator.mjs";
import { updateStoryStats, cleanupOldEvents, updateVelocitySignals } from "../../src/stats-updater.mjs";
import { cleanupStaleMedia, getPromptTemplateStats, getUnenrichedStoryIds } from "../../src/db.mjs";
import * as log from "../../src/log.mjs";

export { GlobalVisualFeedCoordinator };

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (pathname === "/" || pathname === "/health") {
      return Response.json({
        ok: true,
        service: "newsroll-media",
        environment: env.ENVIRONMENT ?? "unknown"
      });
    }

    if (pathname === "/stats/templates") {
      const url = new URL(request.url);
      const days = Number.parseInt(url.searchParams.get("days") ?? "30", 10);
      const stats = await getPromptTemplateStats(env, Number.isFinite(days) && days > 0 ? days : 30);
      return Response.json({ ok: true, stats });
    }

    return new Response("Not Found", { status: 404 });
  },

  async scheduled(controller, env) {
    const start = Date.now();
    log.info({ event: "cron_start", cron: controller.cron, categories: FEED_CATEGORIES.length });
    if (controller.cron === "*/5 * * * *") {
      let remainingMediaBudget = mediaPerRunLimit(env);
      for (const category of FEED_CATEGORIES) {
        if (remainingMediaBudget <= 0) {
          log.info({ event: "cron_media_run_limit_reached", cron: controller.cron, remainingMediaBudget });
          break;
        }
        try {
          const result = await ingestStories(env, category, {
            remainingQueueBudget: remainingMediaBudget
          });
          remainingMediaBudget = Math.max(0, remainingMediaBudget - Number(result?.queued ?? 0));
        } catch (err) {
          log.error({ event: "cron_category_fail", cron: controller.cron, category, ...log.fmtError(err) });
        }
      }
    }
    // Backfill enrichment for stories missing topics
    try {
      const unenrichedIds = await getUnenrichedStoryIds(env, 50);
      for (const storyId of unenrichedIds) {
        try {
          await enrichPublishedStory(env, storyId);
        } catch (err) {
          log.warn({ event: "backfill_enrich_fail", storyId, ...log.fmtError(err) });
        }
      }
    } catch (err) {
      log.error({ event: "backfill_enrichment_fail", ...log.fmtError(err) });
    }

    // Aggregate stale user profiles
    try {
      await aggregateStaleProfiles(env, 100);
    } catch (err) {
      log.error({ event: "profile_aggregation_fail", ...log.fmtError(err) });
    }

    // Update story engagement stats
    try {
      await updateStoryStats(env);
    } catch (err) {
      log.error({ event: "stats_update_fail", ...log.fmtError(err) });
    }

    // Refresh velocity signals and sync active items to Shaped
    try {
      await updateVelocitySignals(env);
    } catch (err) {
      log.error({ event: "velocity_signals_fail", ...log.fmtError(err) });
    }

    // Monthly cleanup of old events (runs every cron but only deletes >30 day old)
    try {
      await cleanupOldEvents(env);
    } catch (err) {
      log.error({ event: "event_cleanup_fail", ...log.fmtError(err) });
    }

    // Cleanup failed/dead_letter media older than 7 days
    try {
      const cleaned = await cleanupStaleMedia(env, 7);
      if (cleaned > 0) {
        log.info({ event: "stale_media_cleaned", count: cleaned });
      }
    } catch (err) {
      log.error({ event: "stale_media_cleanup_fail", ...log.fmtError(err) });
    }

    log.info({ event: "cron_complete", cron: controller.cron, durationMs: Date.now() - start });
  },

  async queue(batch, env) {
    log.info({ event: "queue_batch_start", queue: batch.queue, count: batch.messages.length });
    const start = Date.now();

    const mediaMessages = [];
    for (const message of batch.messages) {
      if (message.body?.type === "enrich_topics") {
        log.info({ event: "topic_enrich_skip", storyId: message.body?.storyId ?? null, reason: "crawl_metadata_replaced_llm" });
        message.ack();
        continue;
      }
      mediaMessages.push(message);
    }

    if (mediaMessages.length > 0) {
      await processMediaMessage({ ...batch, messages: mediaMessages }, env);
    }

    log.info({ event: "queue_batch_complete", queue: batch.queue, count: batch.messages.length, durationMs: Date.now() - start });
  }
};
