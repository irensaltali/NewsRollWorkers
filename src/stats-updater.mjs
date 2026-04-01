import * as log from "./log.mjs";
import { refreshItemVelocity } from "./shaped.mjs";
import { updateStoryStats, getActiveStoryIds, cleanupOldUserEvents } from "./db.mjs";

export { updateStoryStats };

export async function updateVelocitySignals(env) {
  if (!env?.SUPABASE_URL) return 0;

  const storyIds = await getActiveStoryIds(env, 120);
  let updated = 0;

  for (const storyId of storyIds) {
    try {
      const result = await refreshItemVelocity(env, storyId);
      if (result) updated++;
    } catch (err) {
      log.warn({ event: "velocity_update_fail", storyId, ...log.fmtError(err) });
    }
  }

  if (updated > 0) {
    log.info({ event: "velocity_signals_updated", count: updated });
  }
  return updated;
}

export async function cleanupOldEvents(env) {
  if (!env?.SUPABASE_URL) return 0;

  const deleted = await cleanupOldUserEvents(env, 30);
  if (deleted > 0) {
    log.info({ event: "old_events_cleaned", count: deleted });
  }
  return deleted;
}
