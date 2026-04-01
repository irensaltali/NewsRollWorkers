-- Shaped integration: richer item-side signals on published_feed_entries
-- All columns are additive (backward-compatible); existing rows receive defaults.

-- Content understanding
ALTER TABLE published_feed_entries ADD COLUMN publisher       TEXT;
ALTER TABLE published_feed_entries ADD COLUMN has_author      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE published_feed_entries ADD COLUMN article_length  INTEGER;
ALTER TABLE published_feed_entries ADD COLUMN language        TEXT;
ALTER TABLE published_feed_entries ADD COLUMN entities        TEXT;     -- JSON [{name, type}]

-- Quality / source priors
ALTER TABLE published_feed_entries ADD COLUMN publisher_tier             INTEGER NOT NULL DEFAULT 2;  -- 1=high 2=mid 3=low
ALTER TABLE published_feed_entries ADD COLUMN source_reliability_score   REAL    NOT NULL DEFAULT 0.5;

-- Momentum / velocity (refreshed every 5 min by the media worker cron)
ALTER TABLE published_feed_entries ADD COLUMN ctr_5m           REAL NOT NULL DEFAULT 0.0;
ALTER TABLE published_feed_entries ADD COLUMN ctr_30m          REAL NOT NULL DEFAULT 0.0;
ALTER TABLE published_feed_entries ADD COLUMN ctr_2h           REAL NOT NULL DEFAULT 0.0;
ALTER TABLE published_feed_entries ADD COLUMN save_rate_2h     REAL NOT NULL DEFAULT 0.0;
ALTER TABLE published_feed_entries ADD COLUMN skip_rate_30m    REAL NOT NULL DEFAULT 0.0;
ALTER TABLE published_feed_entries ADD COLUMN completion_rate_2h REAL NOT NULL DEFAULT 0.0;
