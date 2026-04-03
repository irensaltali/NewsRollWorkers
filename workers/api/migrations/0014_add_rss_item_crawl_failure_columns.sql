ALTER TABLE public.rss_items
  ADD COLUMN IF NOT EXISTS crawl_failed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS crawl_failure_reason text,
  ADD COLUMN IF NOT EXISTS crawl_failed_at timestamptz;
