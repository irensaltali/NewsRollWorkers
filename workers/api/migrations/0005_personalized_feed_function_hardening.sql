-- Personalized feed RPC hardening
-- Sets search_path explicitly for recommendation/profile/feed functions.

CREATE OR REPLACE FUNCTION public.insert_events_deduped(
  p_user_id UUID,
  p_events JSONB
) RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  inserted_count INTEGER := 0;
BEGIN
  IF p_events IS NULL OR jsonb_typeof(p_events) <> 'array' OR jsonb_array_length(p_events) = 0 THEN
    RETURN 0;
  END IF;

  WITH incoming AS (
    SELECT value AS event
    FROM jsonb_array_elements(p_events)
  ),
  normalized AS (
    SELECT
      COALESCE(NULLIF(event->>'eventId', ''), md5(random()::text || clock_timestamp()::text)) AS event_id,
      p_user_id AS user_id,
      (event->>'storyId')::BIGINT AS story_id,
      NULLIF(event->>'eventType', '') AS event_type,
      COALESCE(NULLIF(event->>'occurredAt', ''), now()::text) AS occurred_at,
      NULLIF(event->>'sessionId', '') AS session_id,
      COALESCE(NULLIF(event->>'surface', ''), 'unknown') AS surface,
      NULLIF(event->>'position', '')::INTEGER AS position,
      NULLIF(event->>'feedMode', '') AS feed_mode,
      NULLIF(event->>'dwellMs', '')::INTEGER AS dwell_ms,
      CASE
        WHEN jsonb_typeof(event->'metadata') = 'object' THEN event->'metadata'
        WHEN jsonb_typeof(event->'eventValue') = 'object' THEN event->'eventValue'
        ELSE NULL
      END AS metadata_json,
      NULLIF(event->>'label', '')::DOUBLE PRECISION AS incoming_label,
      NULLIF(event->>'aiAction', '') AS ai_action,
      CASE
        WHEN event ? 'aiCached' THEN (event->>'aiCached')::BOOLEAN
        ELSE NULL
      END AS ai_cached,
      NULLIF(event->>'aiCreditsUsed', '')::INTEGER AS ai_credits_used
    FROM incoming
  ),
  enriched AS (
    SELECT
      n.*,
      pfe.source_endpoint,
      COALESCE(
        NULLIF(pfe.media_type, ''),
        CASE
          WHEN COALESCE(pfe.media_url, '') ~* '\\.(mp4|mov|m3u8)(\\?.*)?$' THEN 'video'
          WHEN COALESCE(pfe.media_url, '') = '' THEN NULL
          ELSE 'image'
        END
      ) AS media_type,
      CASE
        WHEN jsonb_typeof(pfe.topics) = 'array' THEN pfe.topics->>0
        ELSE NULL
      END AS topic_primary,
      COALESCE(
        n.incoming_label,
        CASE
          WHEN n.event_type = 'hide' THEN -2.0
          WHEN n.event_type = 'skip' AND COALESCE(n.dwell_ms, 0) < 1500 THEN -1.0
          WHEN n.event_type = 'skip' THEN -0.5
          WHEN n.event_type = 'impression' THEN 0.05
          WHEN n.event_type = 'dwell' AND COALESCE(n.dwell_ms, 0) < 3000 THEN 0.10
          WHEN n.event_type = 'dwell' AND COALESCE(n.dwell_ms, 0) <= 10000 THEN 0.30
          WHEN n.event_type = 'dwell' THEN 0.75
          WHEN n.event_type = 'detail_open' THEN 1.0
          WHEN n.event_type = 'external_open' THEN 1.25
          WHEN n.event_type = 'complete' THEN 1.0
          WHEN n.event_type IN ('share', 'save', 'vote') THEN 2.0
          WHEN n.event_type = 'ai_summary_request' THEN 0.6
          WHEN n.event_type = 'ai_explain_request' THEN 0.8
          WHEN n.event_type = 'ai_translate_request' THEN 0.5
          WHEN n.event_type = 'ai_thread_intelligence_request' THEN 0.7
          ELSE 0
        END
      ) AS label
    FROM normalized n
    LEFT JOIN public.published_feed_entries pfe
      ON pfe.story_id = n.story_id
  ),
  inserted AS (
    INSERT INTO public.user_events (
      event_id,
      user_id,
      story_id,
      event_type,
      event_value,
      created_at,
      session_id,
      surface,
      position,
      feed_mode,
      occurred_at,
      dwell_ms,
      metadata_json,
      label,
      source_endpoint,
      topic_primary,
      media_type,
      ai_action,
      ai_cached,
      ai_credits_used
    )
    SELECT
      event_id,
      user_id,
      story_id,
      event_type,
      NULL,
      occurred_at::timestamptz,
      session_id,
      surface,
      position,
      feed_mode,
      occurred_at,
      dwell_ms,
      metadata_json,
      label,
      source_endpoint,
      topic_primary,
      media_type,
      ai_action,
      ai_cached,
      ai_credits_used
    FROM enriched
    ON CONFLICT (event_id) DO NOTHING
    RETURNING session_id, surface, event_type
  )
  SELECT COUNT(*) INTO inserted_count FROM inserted;

  INSERT INTO public.user_sessions (session_id, user_id, surface)
  SELECT DISTINCT session_id, p_user_id, surface
  FROM (
    SELECT
      NULLIF(value->>'sessionId', '') AS session_id,
      COALESCE(NULLIF(value->>'surface', ''), 'unknown') AS surface
    FROM jsonb_array_elements(p_events)
  ) sessions
  WHERE session_id IS NOT NULL
  ON CONFLICT (session_id) DO NOTHING;

  UPDATE public.user_sessions us
  SET
    ended_at = now(),
    cards_viewed = us.cards_viewed + agg.cards_viewed,
    detail_opens = us.detail_opens + agg.detail_opens,
    external_opens = us.external_opens + agg.external_opens,
    shares = us.shares + agg.shares,
    saves = us.saves + agg.saves,
    hides = us.hides + agg.hides,
    ai_actions = us.ai_actions + agg.ai_actions
  FROM (
    SELECT
      session_id,
      COUNT(*) FILTER (WHERE event_type = 'impression') AS cards_viewed,
      COUNT(*) FILTER (WHERE event_type = 'detail_open') AS detail_opens,
      COUNT(*) FILTER (WHERE event_type = 'external_open') AS external_opens,
      COUNT(*) FILTER (WHERE event_type = 'share') AS shares,
      COUNT(*) FILTER (WHERE event_type = 'save') AS saves,
      COUNT(*) FILTER (WHERE event_type = 'hide') AS hides,
      COUNT(*) FILTER (WHERE event_type LIKE 'ai_%') AS ai_actions
    FROM (
      SELECT
        NULLIF(value->>'sessionId', '') AS session_id,
        NULLIF(value->>'eventType', '') AS event_type
      FROM jsonb_array_elements(p_events)
    ) batch_events
    WHERE session_id IS NOT NULL
    GROUP BY session_id
  ) agg
  WHERE us.session_id = agg.session_id;

  RETURN inserted_count;
END;
$$;

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
    pfe.media_url,
    COALESCE(pfe.media_status, 'ready') AS media_status,
    pfe.headline
  FROM public.published_feed_entries pfe
  WHERE p_cursor IS NULL OR pfe.publish_sequence < p_cursor
  ORDER BY pfe.publish_sequence DESC
  LIMIT LEAST(GREATEST(p_limit, 1), 100);
$$;

CREATE OR REPLACE FUNCTION public.get_recommendation_candidates(
  p_limit INTEGER DEFAULT 200
) RETURNS SETOF public.published_feed_entries
LANGUAGE sql
SET search_path = public
AS $$
  SELECT *
  FROM public.published_feed_entries
  WHERE COALESCE(media_status, 'ready') = 'ready'
  ORDER BY publish_sequence DESC
  LIMIT LEAST(GREATEST(p_limit, 1), 500);
$$;

CREATE OR REPLACE FUNCTION public.get_profile_events(
  p_user_id UUID,
  p_days INTEGER DEFAULT 30
) RETURNS TABLE (
  story_id BIGINT,
  event_type TEXT,
  label DOUBLE PRECISION,
  source_endpoint TEXT,
  topic_primary TEXT,
  topics JSONB,
  occurred_at TEXT,
  created_at TEXT
)
LANGUAGE sql
SET search_path = public
AS $$
  SELECT
    ue.story_id,
    ue.event_type,
    ue.label,
    COALESCE(ue.source_endpoint, pfe.source_endpoint) AS source_endpoint,
    COALESCE(ue.topic_primary, CASE WHEN jsonb_typeof(pfe.topics) = 'array' THEN pfe.topics->>0 ELSE NULL END) AS topic_primary,
    CASE
      WHEN pfe.topics IS NULL THEN '[]'::jsonb
      ELSE pfe.topics
    END AS topics,
    ue.occurred_at,
    ue.created_at::text
  FROM public.user_events ue
  LEFT JOIN public.published_feed_entries pfe
    ON pfe.story_id = ue.story_id
  WHERE ue.user_id = p_user_id
    AND COALESCE(NULLIF(ue.occurred_at, ''), ue.created_at::text)::timestamptz >= now() - make_interval(days => GREATEST(p_days, 1));
$$;

CREATE OR REPLACE FUNCTION public.get_stale_profile_users(
  p_limit INTEGER DEFAULT 100
) RETURNS TABLE (user_id UUID)
LANGUAGE sql
SET search_path = public
AS $$
  SELECT DISTINCT ue.user_id
  FROM public.user_events ue
  LEFT JOIN public.user_profiles up
    ON up.user_id = ue.user_id
  WHERE up.updated_at IS NULL
     OR COALESCE(NULLIF(up.updated_at::text, ''), '1970-01-01T00:00:00Z')::timestamptz < now() - interval '30 minutes'
  ORDER BY ue.user_id
  LIMIT LEAST(GREATEST(p_limit, 1), 1000);
$$;

CREATE OR REPLACE FUNCTION public.get_story_velocity_window(
  p_story_id BIGINT,
  p_minutes INTEGER DEFAULT 120
) RETURNS TABLE (
  imp BIGINT,
  eng BIGINT,
  saves BIGINT,
  skips BIGINT,
  completes BIGINT,
  detail_opens BIGINT,
  shares BIGINT,
  hides BIGINT,
  ai_actions BIGINT
)
LANGUAGE sql
SET search_path = public
AS $$
  WITH scoped AS (
    SELECT event_type
    FROM public.user_events
    WHERE story_id = p_story_id
      AND COALESCE(NULLIF(occurred_at, ''), created_at::text)::timestamptz >= now() - make_interval(mins => GREATEST(p_minutes, 1))
  )
  SELECT
    COUNT(*) FILTER (WHERE event_type = 'impression') AS imp,
    COUNT(*) FILTER (WHERE event_type IN ('dwell', 'complete', 'vote', 'save', 'share', 'detail_open', 'external_open')) AS eng,
    COUNT(*) FILTER (WHERE event_type = 'save') AS saves,
    COUNT(*) FILTER (WHERE event_type = 'skip') AS skips,
    COUNT(*) FILTER (WHERE event_type = 'complete') AS completes,
    COUNT(*) FILTER (WHERE event_type = 'detail_open') AS detail_opens,
    COUNT(*) FILTER (WHERE event_type = 'share') AS shares,
    COUNT(*) FILTER (WHERE event_type = 'hide') AS hides,
    COUNT(*) FILTER (WHERE event_type LIKE 'ai_%') AS ai_actions
  FROM scoped;
$$;
