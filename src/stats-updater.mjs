import * as log from "./log.mjs";
import { updateStoryStats, cleanupOldUserEvents } from "./db.mjs";

export { updateStoryStats };

export async function cleanupOldEvents(env) {
  if (!env?.SUPABASE_URL) return 0;

  const deleted = await cleanupOldUserEvents(env, 30);
  if (deleted > 0) {
    log.info({ event: "old_events_cleaned", count: deleted });
  }
  return deleted;
}
