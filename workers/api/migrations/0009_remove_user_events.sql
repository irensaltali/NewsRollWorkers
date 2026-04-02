-- Remove raw user_events storage from Supabase.
-- Event ingestion now goes to Cloudflare Analytics Engine and Shaped.

WITH story_stats AS (
  SELECT
    story_id,
    COUNT(*) FILTER (WHERE event_type = 'impression') AS impression_count,
    COUNT(*) FILTER (WHERE event_type IN ('dwell', 'complete', 'vote', 'save', 'share', 'detail_open', 'external_open')) AS engagement_count
  FROM public.user_events
  GROUP BY story_id
)
UPDATE public.published_feed_entries pfe
SET
  impression_count = COALESCE(story_stats.impression_count, pfe.impression_count, 0),
  engagement_count = COALESCE(story_stats.engagement_count, pfe.engagement_count, 0)
FROM story_stats
WHERE story_stats.story_id = pfe.story_id;

DROP FUNCTION IF EXISTS public.insert_events_deduped(UUID, JSONB);
DROP FUNCTION IF EXISTS public.get_profile_events(UUID, INTEGER);
DROP FUNCTION IF EXISTS public.get_stale_profile_users(INTEGER);
DROP FUNCTION IF EXISTS public.get_story_velocity_window(BIGINT, INTEGER);
DROP FUNCTION IF EXISTS public.get_active_story_ids(INTEGER);
DROP FUNCTION IF EXISTS public.cleanup_old_user_events(INTEGER);
DROP FUNCTION IF EXISTS public.update_story_stats();

DROP TABLE IF EXISTS public.user_events;
