-- Make story_content inspectable in Supabase by storing source/feed URLs
-- and the latest AI summary/explanation alongside readable text.

ALTER TABLE public.story_content
  ALTER COLUMN source_kind SET DEFAULT 'unknown';

ALTER TABLE public.story_content
  ADD COLUMN IF NOT EXISTS source_url TEXT,
  ADD COLUMN IF NOT EXISTS feed_url TEXT,
  ADD COLUMN IF NOT EXISTS summary TEXT,
  ADD COLUMN IF NOT EXISTS explanation TEXT;

WITH preferred_rss AS (
  SELECT DISTINCT ON (ri.story_id)
    ri.story_id,
    COALESCE(NULLIF(ri.canonical_url, ''), NULLIF(ri.url, '')) AS source_url,
    rs.feed_url,
    ri.ingested_at,
    rs.tier
  FROM public.rss_items ri
  JOIN public.rss_sources rs
    ON rs.id = ri.source_id
  ORDER BY ri.story_id, rs.tier ASC, ri.ingested_at ASC
)
INSERT INTO public.story_content (
  story_id,
  source_kind,
  source_url,
  feed_url,
  updated_at
)
SELECT
  preferred_rss.story_id,
  'rss',
  preferred_rss.source_url,
  preferred_rss.feed_url,
  now()
FROM preferred_rss
LEFT JOIN public.story_content existing
  ON existing.story_id = preferred_rss.story_id
WHERE existing.story_id IS NULL;

WITH preferred_rss AS (
  SELECT DISTINCT ON (ri.story_id)
    ri.story_id,
    COALESCE(NULLIF(ri.canonical_url, ''), NULLIF(ri.url, '')) AS source_url,
    rs.feed_url
  FROM public.rss_items ri
  JOIN public.rss_sources rs
    ON rs.id = ri.source_id
  ORDER BY ri.story_id, rs.tier ASC, ri.ingested_at ASC
)
UPDATE public.story_content sc
SET
  source_url = COALESCE(sc.source_url, preferred_rss.source_url),
  feed_url = COALESCE(sc.feed_url, preferred_rss.feed_url)
FROM preferred_rss
WHERE preferred_rss.story_id = sc.story_id;

WITH latest_summary AS (
  SELECT DISTINCT ON (story_id)
    story_id,
    NULLIF(result_text, '') AS summary
  FROM public.ai_results_cache
  WHERE story_id IS NOT NULL
    AND result_type = 'summary'
  ORDER BY story_id, created_at DESC
)
UPDATE public.story_content sc
SET summary = COALESCE(sc.summary, latest_summary.summary)
FROM latest_summary
WHERE latest_summary.story_id = sc.story_id
  AND latest_summary.summary IS NOT NULL;

WITH latest_explain AS (
  SELECT DISTINCT ON (story_id)
    story_id,
    result_text::jsonb AS payload
  FROM public.ai_results_cache
  WHERE story_id IS NOT NULL
    AND result_type IN ('explain_simple', 'explain_technical')
    AND NULLIF(result_text, '') IS NOT NULL
  ORDER BY story_id, created_at DESC
),
formatted_explain AS (
  SELECT
    latest_explain.story_id,
    NULLIF(
      CONCAT_WS(
        E'\n\n',
        NULLIF(latest_explain.payload->>'title', ''),
        NULLIF((
          SELECT string_agg(
            CASE
              WHEN COALESCE(section->>'heading', '') <> '' AND COALESCE(section->>'body', '') <> ''
                THEN (section->>'heading') || E':\n' || (section->>'body')
              WHEN COALESCE(section->>'body', '') <> ''
                THEN section->>'body'
              WHEN COALESCE(section->>'heading', '') <> ''
                THEN section->>'heading'
              ELSE NULL
            END,
            E'\n\n'
          )
          FROM jsonb_array_elements(COALESCE(latest_explain.payload->'sections', '[]'::jsonb)) section
        ), ''),
        NULLIF((
          SELECT CASE
            WHEN COUNT(*) = 0 THEN NULL
            ELSE 'Follow-Ups:' || E'\n' || string_agg('• ' || follow_up, E'\n')
          END
          FROM jsonb_array_elements_text(COALESCE(latest_explain.payload->'followUps', '[]'::jsonb)) follow_up
        ), '')
      ),
      ''
    ) AS explanation
  FROM latest_explain
)
UPDATE public.story_content sc
SET explanation = COALESCE(sc.explanation, formatted_explain.explanation)
FROM formatted_explain
WHERE formatted_explain.story_id = sc.story_id
  AND formatted_explain.explanation IS NOT NULL;
