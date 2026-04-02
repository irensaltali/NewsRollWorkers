-- Normalize legacy FAL image model aliases to the canonical endpoint id.

UPDATE public.prompt_templates
SET
  model = 'fal-ai/flux-2/turbo',
  updated_at = now()
WHERE provider = 'fal'
  AND modality = 'image'
  AND model = 'flux-2-turbo';
