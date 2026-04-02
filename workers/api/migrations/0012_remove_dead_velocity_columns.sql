-- Remove dead velocity signal columns from published feed entries.

ALTER TABLE public.published_feed_entries
  DROP COLUMN IF EXISTS ctr_5m,
  DROP COLUMN IF EXISTS ctr_30m,
  DROP COLUMN IF EXISTS ctr_2h,
  DROP COLUMN IF EXISTS save_rate_2h,
  DROP COLUMN IF EXISTS skip_rate_30m,
  DROP COLUMN IF EXISTS completion_rate_2h,
  DROP COLUMN IF EXISTS detail_open_rate_2h,
  DROP COLUMN IF EXISTS share_rate_2h,
  DROP COLUMN IF EXISTS hide_rate_2h,
  DROP COLUMN IF EXISTS ai_action_rate_24h;
