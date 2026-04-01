-- Multi-source RSS ingestion: feed registry and parsed item cache

CREATE TABLE rss_sources (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  name                   TEXT    NOT NULL,
  feed_url               TEXT    NOT NULL UNIQUE,
  category               TEXT    NOT NULL,     -- matches FEED_CATEGORIES value
  tier                   INTEGER NOT NULL DEFAULT 2,  -- 1=trusted 2=analysis 3=fast/trendy
  reliability_score      REAL    NOT NULL DEFAULT 0.5,
  language               TEXT    NOT NULL DEFAULT 'en',
  active                 INTEGER NOT NULL DEFAULT 1,
  fetch_interval_minutes INTEGER NOT NULL DEFAULT 30,
  last_fetched_at        TEXT,
  created_at             TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- One row per (source, article) pair. story_id is a hash-based canonical integer derived
-- from the canonical URL, so two sources covering the same article share the same story_id.
-- This drives natural deduplication across the rest of the pipeline.
CREATE TABLE rss_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  story_id        INTEGER NOT NULL,   -- hash of canonical_url (stable, shared across sources)
  source_id       INTEGER NOT NULL REFERENCES rss_sources(id),
  guid            TEXT    NOT NULL,
  url             TEXT    NOT NULL,
  canonical_url   TEXT    NOT NULL,
  title           TEXT    NOT NULL,
  description     TEXT,
  author          TEXT,
  published_at    TEXT,
  ingested_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source_id, guid)
);

CREATE INDEX rss_items_story_id ON rss_items(story_id);
CREATE INDEX rss_items_canonical ON rss_items(canonical_url);
CREATE INDEX rss_items_source    ON rss_items(source_id, published_at DESC);

-- ── Seed: initial RSS source registry ────────────────────────────────────────
INSERT INTO rss_sources (name, feed_url, category, tier, reliability_score, language, fetch_interval_minutes) VALUES
-- General News — Tier 1 (trusted)
('Reuters',                 'https://feeds.reuters.com/reuters/topNews',              'general', 1, 0.95, 'en', 15),
('AP News',                 'https://feeds.apnews.com/apf-topnews',                   'general', 1, 0.95, 'en', 15),
('BBC World',               'http://feeds.bbci.co.uk/news/world/rss.xml',             'general', 1, 0.90, 'en', 15),
('The Guardian',            'https://www.theguardian.com/world/rss',                  'general', 2, 0.85, 'en', 30),
('Al Jazeera',              'https://www.aljazeera.com/xml/rss/all.xml',              'general', 2, 0.80, 'en', 30),
-- US / World
('NYTimes',                 'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml', 'general', 1, 0.90, 'en', 30),
('Washington Post',         'http://feeds.washingtonpost.com/rss/national',           'general', 1, 0.88, 'en', 30),
('CNN',                     'http://rss.cnn.com/rss/edition.rss',                     'general', 2, 0.78, 'en', 30),
('Foreign Policy',          'https://foreignpolicy.com/feed/',                        'general', 2, 0.88, 'en', 60),
('The Economist',           'https://www.economist.com/latest/rss.xml',               'general', 1, 0.92, 'en', 60),
('CFR',                     'https://www.cfr.org/rss',                                'general', 2, 0.88, 'en', 60),
-- Local (English-language Turkish press)
('Anadolu Agency',          'https://www.aa.com.tr/en/rss/default?cat=guncel',        'general', 2, 0.80, 'en', 30),
('Daily Sabah',             'https://www.dailysabah.com/rss',                         'general', 2, 0.72, 'en', 30),
-- Trend signals
('Reddit r/news',           'https://www.reddit.com/r/news/.rss',                     'general', 3, 0.55, 'en', 15),
('Reddit r/worldnews',      'https://www.reddit.com/r/worldnews/.rss',                'general', 3, 0.55, 'en', 15),
-- Tech & AI
('TechCrunch',              'https://techcrunch.com/feed/',                           'tech', 2, 0.75, 'en', 30),
('The Verge',               'https://www.theverge.com/rss/index.xml',                 'tech', 2, 0.75, 'en', 30),
('Wired',                   'https://www.wired.com/feed/rss',                         'tech', 2, 0.80, 'en', 30),
('Ars Technica',            'http://feeds.arstechnica.com/arstechnica/index',         'tech', 2, 0.80, 'en', 30),
('MIT Technology Review',   'https://www.technologyreview.com/feed/',                 'tech', 1, 0.88, 'en', 60),
('OpenAI Blog',             'https://openai.com/blog/rss.xml',                        'tech', 2, 0.85, 'en', 60),
('DeepMind Blog',           'https://deepmind.google/blog/rss.xml',                   'tech', 2, 0.85, 'en', 60),
('Hacker News',             'https://hnrss.org/frontpage',                            'tech', 3, 0.70, 'en', 15),
('Y Combinator Blog',       'https://www.ycombinator.com/blog/feed',                  'tech', 2, 0.80, 'en', 60),
('Product Hunt',            'https://www.producthunt.com/feed',                       'tech', 3, 0.65, 'en', 60),
-- Business & Finance
('Bloomberg Markets',       'https://feeds.bloomberg.com/markets/news.rss',           'business', 1, 0.90, 'en', 15),
('CNBC',                    'https://www.cnbc.com/id/100003114/device/rss/rss.html',  'business', 2, 0.80, 'en', 15),
('Financial Times',         'https://www.ft.com/rss/home',                            'business', 1, 0.92, 'en', 30),
('WSJ World',               'https://feeds.a.dj.com/rss/RSSWorldNews.xml',            'business', 1, 0.90, 'en', 30),
('CoinDesk',                'https://www.coindesk.com/arc/outboundfeeds/rss/',         'business', 2, 0.72, 'en', 30),
('CoinTelegraph',           'https://cointelegraph.com/rss',                          'business', 3, 0.65, 'en', 30),
('The Block',               'https://www.theblock.co/rss.xml',                        'business', 2, 0.70, 'en', 30),
-- Science & Health
('Nature',                  'https://www.nature.com/nature.rss',                      'science', 1, 0.97, 'en', 60),
('ScienceDaily',            'https://www.sciencedaily.com/rss/all.xml',               'science', 2, 0.82, 'en', 60),
('WHO News',                'https://www.who.int/rss-feeds/news-english.xml',         'science', 1, 0.90, 'en', 60),
('NASA Climate',            'https://climate.nasa.gov/feed/',                         'science', 1, 0.92, 'en', 60),
('UNEP',                    'https://www.unep.org/rss.xml',                           'science', 1, 0.88, 'en', 60),
('Inside Climate News',     'https://insideclimatenews.org/feed/',                    'science', 2, 0.80, 'en', 60),
-- Entertainment & Sports
('Variety',                 'https://variety.com/feed/',                              'entertainment', 2, 0.75, 'en', 60),
('Hollywood Reporter',      'https://www.hollywoodreporter.com/feed/',                'entertainment', 2, 0.75, 'en', 60),
('IGN',                     'https://feeds.ign.com/ign/all',                          'entertainment', 2, 0.70, 'en', 30),
('ESPN',                    'https://www.espn.com/espn/rss/news',                     'entertainment', 2, 0.78, 'en', 30),
('BBC Sport',               'http://feeds.bbci.co.uk/sport/rss.xml',                 'entertainment', 1, 0.85, 'en', 30),
('Sky Sports',              'https://www.skysports.com/rss/12040',                    'entertainment', 2, 0.75, 'en', 30);
