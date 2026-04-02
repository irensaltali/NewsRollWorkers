-- NewsRoll consolidated initial migration

-- Installations
CREATE TABLE installations (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  app_version TEXT,
  push_token TEXT,
  push_enabled INTEGER NOT NULL DEFAULT 0,
  revenuecat_app_user_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Feed entries: maps (category, story_id) to a rank.
CREATE TABLE feed_entries (
  endpoint TEXT NOT NULL,
  story_id INTEGER NOT NULL,
  rank INTEGER NOT NULL,
  snapshot_at TEXT NOT NULL,
  PRIMARY KEY (endpoint, story_id)
);
CREATE INDEX feed_entries_endpoint_rank_idx ON feed_entries(endpoint, rank);

-- Crawled / extracted article text, keyed by story id.
CREATE TABLE story_content (
  story_id INTEGER PRIMARY KEY,
  source_kind TEXT NOT NULL,
  extracted_text TEXT,
  headline_prompt TEXT,
  ai_headline TEXT,
  updated_at TEXT NOT NULL
);

-- Prompt templates for media generation.
CREATE TABLE prompt_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  template_text TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  modality TEXT NOT NULL DEFAULT 'image',
  provider TEXT NOT NULL DEFAULT 'fal',
  model TEXT,
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Generated media per story.
CREATE TABLE story_media (
  story_id INTEGER PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending',
  fal_request_id TEXT,
  media_key TEXT,
  media_url TEXT,
  failure_reason TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  image_prompt TEXT,
  updated_at TEXT NOT NULL,
  prompt_template_id INTEGER REFERENCES prompt_templates(id) ON DELETE SET NULL
);
CREATE INDEX story_media_prompt_template_idx ON story_media(prompt_template_id);

-- Published visual feed entries.
CREATE TABLE published_feed_entries (
  story_id INTEGER PRIMARY KEY,
  publish_sequence INTEGER NOT NULL UNIQUE,
  source_endpoint TEXT NOT NULL,
  published_at TEXT NOT NULL,
  topics TEXT DEFAULT '[]',
  quality_score REAL DEFAULT 0.5,
  novelty_score REAL DEFAULT 0.5,
  engagement_count INTEGER DEFAULT 0,
  impression_count INTEGER DEFAULT 0
);
CREATE INDEX published_feed_entries_sequence_idx ON published_feed_entries(publish_sequence DESC);
CREATE INDEX pfe_quality_idx ON published_feed_entries(quality_score DESC);

-- User events for recommendation.
CREATE TABLE user_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  installation_id TEXT NOT NULL,
  story_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  event_value TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX user_events_install_idx ON user_events(installation_id, created_at DESC);
CREATE INDEX user_events_story_idx ON user_events(story_id, event_type);

-- User profile scores for personalization.
CREATE TABLE user_profiles (
  installation_id TEXT PRIMARY KEY,
  topic_scores TEXT NOT NULL DEFAULT '{}',
  endpoint_scores TEXT NOT NULL DEFAULT '{}',
  media_pref TEXT NOT NULL DEFAULT '{}',
  total_impressions INTEGER NOT NULL DEFAULT 0,
  total_engagements INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- AI results cache.
CREATE TABLE ai_results_cache (
  cache_key TEXT PRIMARY KEY,
  result_type TEXT NOT NULL,
  story_id INTEGER,
  result_text TEXT NOT NULL,
  model TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT
);
CREATE INDEX idx_ai_cache_story ON ai_results_cache(story_id, result_type);

-- AI request receipts (billing dedup).
CREATE TABLE ai_request_receipts (
  subscriber_id TEXT NOT NULL,
  action TEXT NOT NULL,
  story_id INTEGER NOT NULL,
  target_language TEXT,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (subscriber_id, action, story_id, target_language, content_hash)
);
CREATE INDEX idx_ai_receipts_story_action ON ai_request_receipts(story_id, action, target_language, content_hash);

-- AI prompt configs.
CREATE TABLE ai_prompt_configs (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'openai',
  model TEXT NOT NULL,
  max_completion_tokens INTEGER NOT NULL,
  system_prompt TEXT NOT NULL,
  user_prompt_template TEXT NOT NULL,
  settings_json TEXT NOT NULL DEFAULT '{}',
  active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Prompt run events (observability).
CREATE TABLE prompt_run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  prompt_kind TEXT NOT NULL,
  prompt_key TEXT NOT NULL,
  prompt_template_id INTEGER REFERENCES prompt_templates(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  model TEXT,
  modality TEXT NOT NULL,
  status TEXT NOT NULL,
  latency_ms INTEGER,
  cache_hit INTEGER NOT NULL DEFAULT 0,
  request_excerpt TEXT,
  response_excerpt TEXT,
  artifact_url TEXT,
  error_text TEXT,
  story_id INTEGER,
  cost_usd REAL,
  cost_currency TEXT,
  cost_estimated INTEGER,
  pricing_source TEXT,
  cost_details_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX prompt_run_events_lookup_idx ON prompt_run_events(prompt_kind, prompt_key, created_at DESC);
CREATE INDEX prompt_run_events_source_idx ON prompt_run_events(source, created_at DESC);

-- Seed prompt templates
INSERT INTO prompt_templates (name, description, template_text, modality, provider, model, settings_json) VALUES
  ('editorial_v1', 'Clean editorial illustration',
   'Editorial illustration for a news story titled "${title}". Article summary: ${sourceText}. Focus on clarity and modern flat-style illustration.',
   'image', 'fal', 'fal-ai/flux-2/turbo', '{"guidance_scale":2.5,"image_size":"portrait_16_9","num_images":1,"enable_safety_checker":true,"output_format":"webp","enable_prompt_expansion":true}'),
  ('editorial_v2_blueprint_noir', 'Blueprint noir style',
   'Create a cinematic editorial illustration for "${title}" as if it were a blueprint pinned to a dark studio wall. Translate this source material into diagrams, sketches, annotated arrows, and luminous interface fragments: ${sourceText}',
   'image', 'fal', 'fal-ai/flux-2/turbo', '{"guidance_scale":2.5,"image_size":"portrait_16_9","num_images":1,"enable_safety_checker":true,"output_format":"webp","enable_prompt_expansion":true}'),
  ('founders_desk_midnight', 'Midnight desk scene',
   'Illustrate "${title}" from the point of view of someone working late at a cluttered desk. Mix laptop glow, sticky notes, rough prototypes, coffee rings, and subtle city lights. Let the article context drive the objects on the desk: ${sourceText}',
   'image', 'fal', 'fal-ai/flux-2/turbo', '{"guidance_scale":2.5,"image_size":"portrait_16_9","num_images":1,"enable_safety_checker":true,"output_format":"webp","enable_prompt_expansion":true}'),
  ('newsroom_infographic', 'Magazine infographic',
   'Create a premium magazine-style infographic illustration for "${title}" with charts, icons, mini-scenes, and editorial typography arranged in a single cohesive spread. Use the article details as the narrative spine: ${sourceText}',
   'image', 'fal', 'fal-ai/flux-2/turbo', '{"guidance_scale":2.5,"image_size":"portrait_16_9","num_images":1,"enable_safety_checker":true,"output_format":"webp","enable_prompt_expansion":true}');

-- Seed AI prompt configs
INSERT INTO ai_prompt_configs (key, name, provider, model, max_completion_tokens, system_prompt, user_prompt_template) VALUES
  ('headline', 'AI Headline', 'openai', 'o4-mini', 150,
   'Write a single-sentence hook summary for the following article. Keep it under 120 characters. Create a sense of mystery or intrigue. No emojis, no clickbait. Output only the summary sentence, nothing else.',
   'Title: {{title}}\n\n{{text}}'),
  ('summary', 'Story Summary', 'openai', 'o4-mini', 2000,
   'You are a concise news analyst. Summarize the following article in 3-5 bullet points. Focus on key facts, implications, and why it matters. No fluff.',
   'Title: {{title}}\n\n{{text}}'),
  ('translation', 'Structured Translation', 'openai', 'o1-mini', 16000,
   'You translate news content into the requested language. Return valid JSON only. Preserve IDs exactly. Translate only human-readable text fields. Do not include markdown fences or commentary.',
   'Target language: {{targetLanguage}}.\n\nTranslate the following structured JSON and respond with an object shaped like:\n{"story":{"title":"...","text":"..."},"comments":[{"id":123,"text":"..."}]}\n\n{{payload}}'),
  ('thread_intelligence', 'Thread Intelligence', 'openai', 'o4-mini', 3000,
   'You analyze news article discussion threads. Summarize the overall discussion, extract the highest-signal insights, and classify the discussion shape as heated, consensus, or mixed. Base your answer only on the provided content.',
   '{{payload}}'),
  ('explain_simple', 'Explain Simple', 'openai', 'o4-mini', 4000,
   'Explain this article in plain language for an informed general reader. Avoid jargon where possible, define important terms briefly, and focus on the core idea and impact.',
   '{{payload}}'),
  ('explain_technical', 'Explain Technical', 'openai', 'o4-mini', 4000,
   'Explain this article for a technical reader. Preserve precise terminology, architecture details, tradeoffs, and implementation implications.',
   '{{payload}}');
