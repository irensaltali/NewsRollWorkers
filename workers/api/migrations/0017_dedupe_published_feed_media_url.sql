-- Make story_media the canonical media URL source.
-- Keep published_feed_entries.media_url only as a deprecated fallback.

UPDATE public.published_feed_entries pfe
SET media_url = NULL
FROM public.story_media sm
WHERE sm.story_id = pfe.story_id
  AND NULLIF(sm.media_url, '') IS NOT NULL
  AND pfe.media_url IS NOT NULL;

CREATE OR REPLACE FUNCTION public.get_visual_feed(
  p_cursor BIGINT DEFAULT NULL,
  p_limit INTEGER DEFAULT 20
) RETURNS TABLE (
  story_id BIGINT,
  publish_sequence BIGINT,
  source_endpoint TEXT,
  published_at TEXT,
  media_url TEXT,
  media_status TEXT,
  headline TEXT
)
LANGUAGE sql
SET search_path = public
AS $$
  SELECT
    pfe.story_id,
    pfe.publish_sequence,
    pfe.source_endpoint,
    pfe.published_at,
    COALESCE(sm.media_url, pfe.media_url) AS media_url,
    COALESCE(pfe.media_status, 'ready') AS media_status,
    pfe.headline
  FROM public.published_feed_entries pfe
  LEFT JOIN public.story_media sm
    ON sm.story_id = pfe.story_id
  WHERE p_cursor IS NULL OR pfe.publish_sequence < p_cursor
  ORDER BY pfe.publish_sequence DESC
  LIMIT LEAST(GREATEST(p_limit, 1), 100);
$$;
