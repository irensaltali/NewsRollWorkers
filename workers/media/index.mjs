import { ingestStories, processMediaMessage } from "../../src/media-pipeline.mjs";
import { FEED_CATEGORIES } from "../../src/config.mjs";
import { GlobalVisualFeedCoordinator } from "../../src/global-visual-feed-coordinator.mjs";
import { enrichPublishedStory, extractTopicsLLM } from "../../src/enrichment.mjs";
import { aggregateStaleProfiles } from "../../src/profile-aggregator.mjs";
import { updateStoryStats, cleanupOldEvents } from "../../src/stats-updater.mjs";
import { cleanupStaleMedia, getPromptTemplateStats } from "../../src/d1.mjs";
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
      for (const category of FEED_CATEGORIES) {
        try {
          await ingestStories(env, category);
        } catch (err) {
          log.error({ event: "cron_category_fail", cron: controller.cron, category, ...log.fmtError(err) });
        }
      }
    }
    // Backfill enrichment for stories missing topics
    try {
      if (env?.DB?.prepare) {
        const unenriched = await env.DB.prepare(
          `SELECT story_id AS storyId FROM published_feed_entries
           WHERE topics = '[]' OR topics IS NULL
           LIMIT 50`
        ).all();
        for (const row of (unenriched.results ?? [])) {
          try {
            await enrichPublishedStory(env, row.storyId);
          } catch (err) {
            log.warn({ event: "backfill_enrich_fail", storyId: row.storyId, ...log.fmtError(err) });
          }
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

    // Separate enrich_topics messages from media messages
    const enrichMessages = [];
    const mediaMessages = [];
    for (const message of batch.messages) {
      if (message.body?.type === "enrich_topics") {
        enrichMessages.push(message);
      } else {
        mediaMessages.push(message);
      }
    }

    // Process media messages
    if (mediaMessages.length > 0) {
      await processMediaMessage({ ...batch, messages: mediaMessages }, env);
    }

    // Process topic enrichment messages
    for (const message of enrichMessages) {
      try {
        const { storyId, title, text } = message.body;
        const topics = await extractTopicsLLM(env, storyId, title, text);
        if (topics && env?.DB?.prepare) {
          await env.DB.prepare(
            "UPDATE published_feed_entries SET topics = ?1 WHERE story_id = ?2"
          ).bind(JSON.stringify(topics), storyId).run();
          log.info({ event: "topic_llm_updated", storyId, topics });
        }
        message.ack();
      } catch (err) {
        log.error({ event: "topic_enrich_fail", storyId: message.body?.storyId, ...log.fmtError(err) });
        message.retry();
      }
    }

    log.info({ event: "queue_batch_complete", queue: batch.queue, count: batch.messages.length, durationMs: Date.now() - start });
  }
};
