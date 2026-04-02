-- Remove enrichment-derived fields from published feed storage.

DROP INDEX IF EXISTS public.pfe_quality_idx;

ALTER TABLE public.published_feed_entries
  DROP COLUMN IF EXISTS topics,
  DROP COLUMN IF EXISTS quality_score,
  DROP COLUMN IF EXISTS novelty_score,
  DROP COLUMN IF EXISTS publisher,
  DROP COLUMN IF EXISTS has_author,
  DROP COLUMN IF EXISTS article_length,
  DROP COLUMN IF EXISTS language,
  DROP COLUMN IF EXISTS entities,
  DROP COLUMN IF EXISTS publisher_tier,
  DROP COLUMN IF EXISTS source_reliability_score,
  DROP COLUMN IF EXISTS topic_count,
  DROP COLUMN IF EXISTS entity_count;

ALTER TABLE public.user_profiles
  DROP COLUMN IF EXISTS topic_scores;

ALTER TABLE IF EXISTS public.user_events
  DROP COLUMN IF EXISTS topic_primary;
