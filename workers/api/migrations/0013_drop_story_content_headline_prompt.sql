-- Remove legacy headline prompt provenance from story content.

ALTER TABLE public.story_content
  DROP COLUMN IF EXISTS headline_prompt;
