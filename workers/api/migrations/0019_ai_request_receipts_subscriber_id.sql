DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'ai_request_receipts'
      AND column_name = 'user_id'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'ai_request_receipts'
      AND column_name = 'subscriber_id'
  ) THEN
    ALTER TABLE public.ai_request_receipts RENAME COLUMN user_id TO subscriber_id;
  END IF;
END $$;

ALTER TABLE public.ai_request_receipts
  ADD COLUMN IF NOT EXISTS subscriber_id TEXT;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'ai_request_receipts'
      AND column_name = 'user_id'
  ) THEN
    UPDATE public.ai_request_receipts
    SET subscriber_id = COALESCE(subscriber_id, user_id::text)
    WHERE subscriber_id IS NULL;
  END IF;
END $$;

UPDATE public.ai_request_receipts
SET target_language = ''
WHERE target_language IS NULL;

ALTER TABLE public.ai_request_receipts
  ALTER COLUMN subscriber_id SET NOT NULL,
  ALTER COLUMN target_language SET DEFAULT '',
  ALTER COLUMN target_language SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ai_request_receipts_subscriber_dedup_idx
  ON public.ai_request_receipts (subscriber_id, action, story_id, target_language, content_hash);
