import { processMediaMessage } from "../../src/media-pipeline.mjs";
import { GlobalVisualFeedCoordinator } from "../../src/global-visual-feed-coordinator.mjs";
import { getImagePromptOptimizerStats } from "../../src/db.mjs";
import * as log from "../../src/log.mjs";

export { GlobalVisualFeedCoordinator };

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (pathname === "/" || pathname === "/health") {
      return Response.json({ ok: true, service: "newsroll-processor", environment: env.ENVIRONMENT ?? "unknown" });
    }

    if (pathname === "/stats/templates" || pathname === "/stats/optimizers") {
      const url = new URL(request.url);
      const days = Number.parseInt(url.searchParams.get("days") ?? "30", 10);
      const stats = await getImagePromptOptimizerStats(env, Number.isFinite(days) && days > 0 ? days : 30);
      return Response.json({ ok: true, stats });
    }

    return new Response("Not Found", { status: 404 });
  },

  async queue(batch, env, ctx) {
    log.info({ event: "queue_batch_start", queue: batch.queue, count: batch.messages.length });
    const start = Date.now();

    const mediaMessages = [];
    for (const message of batch.messages) {
      if (message.body?.type && message.body.type !== "media_generation") {
        log.warn({ event: "queue_message_drop", storyId: message.body?.storyId ?? null, type: message.body.type });
        message.ack();
        continue;
      }
      mediaMessages.push(message);
    }

    if (mediaMessages.length > 0) {
      await processMediaMessage({ ...batch, messages: mediaMessages }, env, ctx);
    }

    log.info({ event: "queue_batch_complete", queue: batch.queue, count: batch.messages.length, durationMs: Date.now() - start });
  }
};
