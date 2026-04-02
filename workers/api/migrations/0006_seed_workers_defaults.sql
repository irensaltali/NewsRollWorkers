-- Align live Supabase seed data with worker expectations.
-- Idempotent: safe to re-apply.

WITH rss_seed(name, feed_url, category, tier, reliability_score, language, fetch_interval_minutes) AS (
  VALUES
    ('Reuters', 'https://feeds.reuters.com/reuters/topNews', 'general', 1, 0.95, 'en', 15),
    ('AP News', 'https://feeds.apnews.com/apf-topnews', 'general', 1, 0.95, 'en', 15),
    ('BBC World', 'http://feeds.bbci.co.uk/news/world/rss.xml', 'general', 1, 0.90, 'en', 15),
    ('The Guardian', 'https://www.theguardian.com/world/rss', 'general', 2, 0.85, 'en', 30),
    ('Al Jazeera', 'https://www.aljazeera.com/xml/rss/all.xml', 'general', 2, 0.80, 'en', 30),
    ('NYTimes', 'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml', 'general', 1, 0.90, 'en', 30),
    ('Washington Post', 'http://feeds.washingtonpost.com/rss/national', 'general', 1, 0.88, 'en', 30),
    ('CNN', 'http://rss.cnn.com/rss/edition.rss', 'general', 2, 0.78, 'en', 30),
    ('Foreign Policy', 'https://foreignpolicy.com/feed/', 'general', 2, 0.88, 'en', 60),
    ('The Economist', 'https://www.economist.com/latest/rss.xml', 'general', 1, 0.92, 'en', 60),
    ('CFR', 'https://www.cfr.org/rss', 'general', 2, 0.88, 'en', 60),
    ('Anadolu Agency', 'https://www.aa.com.tr/en/rss/default?cat=guncel', 'general', 2, 0.80, 'en', 30),
    ('Daily Sabah', 'https://www.dailysabah.com/rss', 'general', 2, 0.72, 'en', 30),
    ('Reddit r/news', 'https://www.reddit.com/r/news/.rss', 'general', 3, 0.55, 'en', 15),
    ('Reddit r/worldnews', 'https://www.reddit.com/r/worldnews/.rss', 'general', 3, 0.55, 'en', 15),
    ('TechCrunch', 'https://techcrunch.com/feed/', 'tech', 2, 0.75, 'en', 30),
    ('The Verge', 'https://www.theverge.com/rss/index.xml', 'tech', 2, 0.75, 'en', 30),
    ('Wired', 'https://www.wired.com/feed/rss', 'tech', 2, 0.80, 'en', 30),
    ('Ars Technica', 'http://feeds.arstechnica.com/arstechnica/index', 'tech', 2, 0.80, 'en', 30),
    ('MIT Technology Review', 'https://www.technologyreview.com/feed/', 'tech', 1, 0.88, 'en', 60),
    ('OpenAI Blog', 'https://openai.com/blog/rss.xml', 'tech', 2, 0.85, 'en', 60),
    ('DeepMind Blog', 'https://deepmind.google/blog/rss.xml', 'tech', 2, 0.85, 'en', 60),
    ('Hacker News', 'https://hnrss.org/frontpage', 'tech', 3, 0.70, 'en', 15),
    ('Y Combinator Blog', 'https://www.ycombinator.com/blog/feed', 'tech', 2, 0.80, 'en', 60),
    ('Product Hunt', 'https://www.producthunt.com/feed', 'tech', 3, 0.65, 'en', 60),
    ('Bloomberg Markets', 'https://feeds.bloomberg.com/markets/news.rss', 'business', 1, 0.90, 'en', 15),
    ('CNBC', 'https://www.cnbc.com/id/100003114/device/rss/rss.html', 'business', 2, 0.80, 'en', 15),
    ('Financial Times', 'https://www.ft.com/rss/home', 'business', 1, 0.92, 'en', 30),
    ('WSJ World', 'https://feeds.a.dj.com/rss/RSSWorldNews.xml', 'business', 1, 0.90, 'en', 30),
    ('CoinDesk', 'https://www.coindesk.com/arc/outboundfeeds/rss/', 'business', 2, 0.72, 'en', 30),
    ('CoinTelegraph', 'https://cointelegraph.com/rss', 'business', 3, 0.65, 'en', 30),
    ('The Block', 'https://www.theblock.co/rss.xml', 'business', 2, 0.70, 'en', 30),
    ('Nature', 'https://www.nature.com/nature.rss', 'science', 1, 0.97, 'en', 60),
    ('ScienceDaily', 'https://www.sciencedaily.com/rss/all.xml', 'science', 2, 0.82, 'en', 60),
    ('WHO News', 'https://www.who.int/rss-feeds/news-english.xml', 'science', 1, 0.90, 'en', 60),
    ('NASA Climate', 'https://climate.nasa.gov/feed/', 'science', 1, 0.92, 'en', 60),
    ('UNEP', 'https://www.unep.org/rss.xml', 'science', 1, 0.88, 'en', 60),
    ('Inside Climate News', 'https://insideclimatenews.org/feed/', 'science', 2, 0.80, 'en', 60),
    ('Variety', 'https://variety.com/feed/', 'entertainment', 2, 0.75, 'en', 60),
    ('Hollywood Reporter', 'https://www.hollywoodreporter.com/feed/', 'entertainment', 2, 0.75, 'en', 60),
    ('IGN', 'https://feeds.ign.com/ign/all', 'entertainment', 2, 0.70, 'en', 30),
    ('ESPN', 'https://www.espn.com/espn/rss/news', 'entertainment', 2, 0.78, 'en', 30),
    ('BBC Sport', 'http://feeds.bbci.co.uk/sport/rss.xml', 'entertainment', 1, 0.85, 'en', 30),
    ('Sky Sports', 'https://www.skysports.com/rss/12040', 'entertainment', 2, 0.75, 'en', 30)
)
INSERT INTO public.rss_sources (
  name,
  feed_url,
  category,
  tier,
  reliability_score,
  language,
  active,
  fetch_interval_minutes
)
SELECT
  name,
  feed_url,
  category,
  tier,
  reliability_score,
  language,
  true,
  fetch_interval_minutes
FROM rss_seed
ON CONFLICT (feed_url) DO UPDATE
SET
  name = EXCLUDED.name,
  category = EXCLUDED.category,
  tier = EXCLUDED.tier,
  reliability_score = EXCLUDED.reliability_score,
  language = EXCLUDED.language,
  active = EXCLUDED.active,
  fetch_interval_minutes = EXCLUDED.fetch_interval_minutes;

WITH prompt_seed(name, description, template_text, modality, provider, model, settings) AS (
  VALUES
    (
      'editorial_v1',
      'Clean editorial illustration',
      'Editorial illustration for a news story titled "${title}". Article summary: ${sourceText}. Focus on clarity and modern flat-style illustration.',
      'image',
      'fal',
      'fal-ai/flux-2/turbo',
      '{"guidance_scale":2.5,"image_size":"portrait_16_9","num_images":1,"enable_safety_checker":true,"output_format":"webp","enable_prompt_expansion":true}'::jsonb
    ),
    (
      'editorial_v2_blueprint_noir',
      'Blueprint noir style',
      'Create a cinematic editorial illustration for "${title}" as if it were a blueprint pinned to a dark studio wall. Translate this source material into diagrams, sketches, annotated arrows, and luminous interface fragments: ${sourceText}',
      'image',
      'fal',
      'fal-ai/flux-2/turbo',
      '{"guidance_scale":2.5,"image_size":"portrait_16_9","num_images":1,"enable_safety_checker":true,"output_format":"webp","enable_prompt_expansion":true}'::jsonb
    ),
    (
      'founders_desk_midnight',
      'Midnight desk scene',
      'Illustrate "${title}" from the point of view of someone working late at a cluttered desk. Mix laptop glow, sticky notes, rough prototypes, coffee rings, and subtle city lights. Let the article context drive the objects on the desk: ${sourceText}',
      'image',
      'fal',
      'fal-ai/flux-2/turbo',
      '{"guidance_scale":2.5,"image_size":"portrait_16_9","num_images":1,"enable_safety_checker":true,"output_format":"webp","enable_prompt_expansion":true}'::jsonb
    ),
    (
      'newsroom_infographic',
      'Magazine infographic',
      'Create a premium magazine-style infographic illustration for "${title}" with charts, icons, mini-scenes, and editorial typography arranged in a single cohesive spread. Use the article details as the narrative spine: ${sourceText}',
      'image',
      'fal',
      'fal-ai/flux-2/turbo',
      '{"guidance_scale":2.5,"image_size":"portrait_16_9","num_images":1,"enable_safety_checker":true,"output_format":"webp","enable_prompt_expansion":true}'::jsonb
    )
)
INSERT INTO public.prompt_templates (
  name,
  description,
  template_text,
  active,
  modality,
  provider,
  model,
  settings,
  created_by,
  created_at,
  updated_at
)
SELECT
  name,
  description,
  template_text,
  true,
  modality,
  provider,
  model,
  settings,
  'migration',
  now(),
  now()
FROM prompt_seed
ON CONFLICT (name) DO UPDATE
SET
  description = EXCLUDED.description,
  template_text = EXCLUDED.template_text,
  active = EXCLUDED.active,
  modality = EXCLUDED.modality,
  provider = EXCLUDED.provider,
  model = EXCLUDED.model,
  settings = EXCLUDED.settings,
  updated_at = now();

WITH ai_prompt_seed(key, name, provider, model, max_completion_tokens, system_prompt, user_prompt_template) AS (
  VALUES
    (
      'headline',
      'AI Headline',
      'openai',
      'o4-mini',
      150,
      'Write a single-sentence hook summary for the following article. Keep it under 120 characters. Create a sense of mystery or intrigue. No emojis, no clickbait. Output only the summary sentence, nothing else.',
      'Title: {{title}}\n\n{{text}}'
    ),
    (
      'summary',
      'Story Summary',
      'openai',
      'o4-mini',
      2000,
      'You are a concise news analyst. Summarize the following article in 3-5 bullet points. Focus on key facts, implications, and why it matters. No fluff.',
      'Title: {{title}}\n\n{{text}}'
    ),
    (
      'translation',
      'Structured Translation',
      'openai',
      'o1-mini',
      16000,
      'You translate news content into the requested language. Return valid JSON only. Preserve IDs exactly. Translate only human-readable text fields. Do not include markdown fences or commentary.',
      'Target language: {{targetLanguage}}.\n\nTranslate the following structured JSON and respond with an object shaped like:\n{"story":{"title":"...","text":"..."},"comments":[{"id":123,"text":"..."}]}\n\n{{payload}}'
    ),
    (
      'thread_intelligence',
      'Thread Intelligence',
      'openai',
      'o4-mini',
      3000,
      'You analyze news article discussion threads. Summarize the overall discussion, extract the highest-signal insights, and classify the discussion shape as heated, consensus, or mixed. Base your answer only on the provided content.',
      '{{payload}}'
    ),
    (
      'explain_simple',
      'Explain Simple',
      'openai',
      'o4-mini',
      4000,
      'Explain this article in plain language for an informed general reader. Avoid jargon where possible, define important terms briefly, and focus on the core idea and impact.',
      '{{payload}}'
    ),
    (
      'explain_technical',
      'Explain Technical',
      'openai',
      'o4-mini',
      4000,
      'Explain this article for a technical reader. Preserve precise terminology, architecture details, tradeoffs, and implementation implications.',
      '{{payload}}'
    )
)
INSERT INTO public.ai_prompt_configs (
  key,
  name,
  provider,
  model,
  max_completion_tokens,
  system_prompt,
  user_prompt_template,
  settings,
  active,
  updated_at,
  created_at
)
SELECT
  key,
  name,
  provider,
  model,
  max_completion_tokens,
  system_prompt,
  user_prompt_template,
  '{}'::jsonb,
  true,
  now(),
  now()
FROM ai_prompt_seed
ON CONFLICT (key) DO UPDATE
SET
  name = EXCLUDED.name,
  provider = EXCLUDED.provider,
  model = EXCLUDED.model,
  max_completion_tokens = EXCLUDED.max_completion_tokens,
  system_prompt = EXCLUDED.system_prompt,
  user_prompt_template = EXCLUDED.user_prompt_template,
  settings = EXCLUDED.settings,
  active = EXCLUDED.active,
  updated_at = now();
