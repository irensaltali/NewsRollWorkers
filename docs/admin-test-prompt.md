# Admin Media API

Admin media testing now uses the same OpenAI prompt-optimizer flow as the production processor pipeline:

`article metadata -> OpenAI optimizer -> optimized image prompt -> Flux/image model -> staged asset -> save/apply`

Image templates are no longer supported. Prompt-optimizer system and user prompts are stored in Supabase and selected by `optimizerKey` and optional `optimizerVersion`.

## Authentication

All admin endpoints require `ADMIN_API_KEY` as a Bearer token.

```bash
export API=http://localhost:8787
export KEY=my-local-secret
```

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/admin/media/crawl` | Submit an async crawl job |
| `GET` | `/admin/media/crawl/:taskId` | Poll crawl status/result |
| `POST` | `/admin/media/prompt` | Resolve article content and return the optimized image prompt |
| `POST` | `/admin/media/generate` | Optimize prompt, generate image, and stage a preview |
| `POST` | `/admin/media/save` | Save a staged preview as a new story |
| `PUT` | `/admin/media/:storyId` | Apply a staged preview to an existing story |
| `POST` | `/admin/test-prompt` | Deprecated alias; same optimizer-backed flow as above |

## Shared Request Fields

### Content source

Pick one or combine:

| Field | Type | Notes |
| --- | --- | --- |
| `crawlTaskId` | string | Reuse a completed async crawl task |
| `storyId` | number | Use an existing story and any cached content |
| `url` | string | Crawl a live URL |
| `title` | string | Manual title |
| `text` | string | Manual article text |

### Optimizer selection

| Field | Type | Notes |
| --- | --- | --- |
| `optimizerKey` | string | Defaults to `news_image_prompt_optimizer` |
| `optimizerVersion` | string | Optional. When omitted, the active DB version is used |
| `logPromptRun` | boolean | Defaults to `true` |

### Image generation overrides

Only used by `/admin/media/generate` and `POST /admin/test-prompt` when `generateImage !== false`.

| Field | Type | Notes |
| --- | --- | --- |
| `provider` | string | Defaults to `fal` |
| `model` | string | Optional image model override |
| `settings` | object | Optional image-generation settings override |

## `POST /admin/media/prompt`

Runs the OpenAI optimizer and returns the saved optimized image prompt. No image is generated.

Example:

```bash
curl -s "$API/admin/media/prompt" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com/article",
    "optimizerKey": "news_image_prompt_optimizer"
  }' | jq .
```

Response shape:

```json
{
  "status": "resolved",
  "resolvedPrompt": "Editorial image prompt...",
  "optimizerUsed": {
    "id": 1,
    "key": "news_image_prompt_optimizer",
    "version": "doc_v1",
    "name": "News Image Prompt Optimizer"
  },
  "optimizerInput": {
    "title": "Article title",
    "headline": "Article headline",
    "summary": "Article summary",
    "topics": ["ai", "agents"],
    "language": "en"
  },
  "promptGenerationId": 42,
  "optimizerPromptRunEventId": 99
}
```

## `POST /admin/media/generate`

Runs the optimizer, saves the generated prompt, generates an image, and stages a preview in R2.

Example:

```bash
curl -s "$API/admin/media/generate" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "storyId": 12345,
    "provider": "fal"
  }' | jq .
```

Important response fields:

```json
{
  "status": "ready",
  "resolvedPrompt": "Editorial image prompt...",
  "optimizerUsed": {
    "id": 1,
    "key": "news_image_prompt_optimizer",
    "version": "doc_v1",
    "name": "News Image Prompt Optimizer"
  },
  "promptGenerationId": 42,
  "optimizerPromptRunEventId": 99,
  "imagePromptRunEventId": 100,
  "previewId": "test-prompts/12345/run.json",
  "previewAssetUrl": "https://media.example.com/test-prompts/12345/run.webp"
}
```

## `POST /admin/media/save`

Promotes a staged preview to a brand-new story.

```bash
curl -s "$API/admin/media/save" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "previewId": "test-prompts/adhoc/run.json",
    "category": "tech"
  }' | jq .
```

## `PUT /admin/media/:storyId`

Applies a staged preview to an existing published story.

```bash
curl -s -X PUT "$API/admin/media/12345" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "previewId": "test-prompts/12345/run.json"
  }' | jq .
```

## Notes

- `prompt_templates`, `templateId`, and `templateText` are removed from the admin workflow.
- Prompt optimizer configs live in Supabase table `image_prompt_optimizer_configs`.
- Saved optimized prompts live in Supabase table `image_prompt_generations`.
- `story_media.image_prompt` keeps the latest selected prompt mirror for the story.
- Shaped payload structure is unchanged.
