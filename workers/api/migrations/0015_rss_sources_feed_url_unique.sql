-- Ensure feed_url is unique on rss_sources.
-- Constraint rss_sources_feed_url_key may already exist; this is idempotent.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'rss_sources_feed_url_key'
      AND conrelid = 'public.rss_sources'::regclass
  ) THEN
    ALTER TABLE public.rss_sources
      ADD CONSTRAINT rss_sources_feed_url_key UNIQUE (feed_url);
  END IF;
END $$;
