import * as log from "./log.mjs";

export async function updateStoryStats(env) {
  if (!env?.DB?.prepare) return 0;

  const result = await env.DB.prepare(
    `UPDATE published_feed_entries
     SET engagement_count = COALESCE((
           SELECT COUNT(*) FROM user_events
           WHERE user_events.story_id = published_feed_entries.story_id
             AND user_events.event_type IN ('vote', 'save', 'share', 'complete')
         ), 0),
         impression_count = COALESCE((
           SELECT COUNT(*) FROM user_events
           WHERE user_events.story_id = published_feed_entries.story_id
             AND user_events.event_type = 'impression'
         ), 0)
     WHERE story_id IN (
       SELECT DISTINCT story_id FROM user_events
       WHERE created_at > datetime('now', '-10 minutes')
     )`
  ).run();

  const updated = result.meta?.changes ?? 0;
  if (updated > 0) {
    log.info({ event: "story_stats_updated", count: updated });
  }
  return updated;
}

export async function cleanupOldEvents(env) {
  if (!env?.DB?.prepare) return 0;

  const result = await env.DB.prepare(
    "DELETE FROM user_events WHERE created_at < datetime('now', '-30 days')"
  ).run();

  const deleted = result.meta?.changes ?? 0;
  if (deleted > 0) {
    log.info({ event: "old_events_cleaned", count: deleted });
  }
  return deleted;
}
