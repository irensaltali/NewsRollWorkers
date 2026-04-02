import { ingestStories, mediaPerRunLimit } from "../../src/media-pipeline.mjs";
import { FEED_CATEGORIES } from "../../src/config.mjs";
import { updateStoryStats, cleanupOldEvents } from "../../src/stats-updater.mjs";
import { cleanupStaleMedia } from "../../src/db.mjs";
import * as log from "../../src/log.mjs";

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/" || pathname === "/health") {
      return Response.json({ ok: true, service: "newsroll-ingest", environment: env.ENVIRONMENT ?? "unknown" });
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
          const result = await ingestStories(env, category, { remainingQueueBudget: remainingMediaBudget });
          remainingMediaBudget = Math.max(0, remainingMediaBudget - Number(result?.queued ?? 0));
        } catch (err) {
          log.error({ event: "cron_category_fail", cron: controller.cron, category, ...log.fmtError(err) });
        }
      }
    }

    try {
      await updateStoryStats(env);
    } catch (err) {
      log.error({ event: "stats_update_fail", ...log.fmtError(err) });
    }

    try {
      await cleanupOldEvents(env);
    } catch (err) {
      log.error({ event: "event_cleanup_fail", ...log.fmtError(err) });
    }

    try {
      const cleaned = await cleanupStaleMedia(env, 7);
      if (cleaned > 0) {
        log.info({ event: "stale_media_cleaned", count: cleaned });
      }
    } catch (err) {
      log.error({ event: "stale_media_cleanup_fail", ...log.fmtError(err) });
    }

    log.info({ event: "cron_complete", cron: controller.cron, durationMs: Date.now() - start });
  }
};
