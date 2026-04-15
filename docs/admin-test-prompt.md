# Admin Media API

Admin media testing now uses the same OpenAI prompt-optimizer flow as the production processor pipeline:

`article metadata -> OpenAI optimizer -> optimized image prompt -> Flux/image model -> staged asset -> save/apply`

Image templates are no longer supported. Prompt-optimizer system and user prompts are stored in Supabase in `image_prompt_optimizer_configs`.

The production media pipeline now routes stories to active prompt variants by topic and keyword match, with fallback to the configured default variant. Admin endpoints use the same routing unless you explicitly target a config.

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
| `POST` | `/admin/test-prompt` | Legacy all-in-one endpoint with extra capabilities (see below) |

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
| `recrawl` | boolean | Force re-crawl even if cached content exists |
| `forceFirecrawl` | boolean | Force Firecrawl provider instead of default |

### Optimizer selection

| Field | Type | Notes |
| --- | --- | --- |
| `optimizerConfigId` | number | Optional. Use this exact `image_prompt_optimizer_configs.id` when you want a specific prompt variant |
| `optimizerKey` | string | Optional selector. Usually `news_image_prompt_optimizer` |
| `optimizerVersion` | string | Optional legacy selector paired with `optimizerKey` |
| `logPromptRun` | boolean | Defaults to `true` |

### Dry-run mode

| Field | Type | Notes |
| --- | --- | --- |
| `dryRun` | boolean | Supported by `POST /admin/media/prompt` and `POST /admin/test-prompt`. When `true`, skips prompt-generation persistence and prompt-run logging. On `POST /admin/test-prompt`, also disables image generation |

### Image generation overrides

Only used by `/admin/media/generate` and `POST /admin/test-prompt` when `generateImage !== false`.

| Field | Type | Notes |
| --- | --- | --- |
| `provider` | string | Optional override. When omitted, admin endpoints use the selected optimizer config's `generationProvider` |
| `model` | string | Optional image model override |
| `settings` | object | Optional image-generation settings override |

### One-call apply options

| Field | Type | Notes |
| --- | --- | --- |
| `applyToStory` | boolean | Supported by `POST /admin/media/generate` when `storyId` is provided. Generates the image and immediately applies it to the existing story |
| `replaceStoryContent` | boolean | Supported by `POST /admin/media/generate`, `PUT /admin/media/:storyId`, and `POST /admin/test-prompt` apply flow. Replaces stored `story_content` fields with the current resolved crawl/content snapshot instead of merging partial fields |

## `POST /admin/media/crawl`

Submits an async crawl job. Returns immediately with a `taskId` to poll.

| Field | Type | Notes |
| --- | --- | --- |
| `url` | string | **Required.** URL to crawl |
| `storyId` | number | Optional. Associate crawl with an existing story |
| `forceFirecrawl` | boolean | Force Firecrawl provider instead of default CF browser rendering |

```bash
curl -s "$API/admin/media/crawl" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{ "url": "https://example.com/article" }' | jq .
```

Response:

```json
{
  "crawlTaskId": "uuid",
  "status": "running",
  "url": "https://example.com/article",
  "storyId": null,
  "forceFirecrawl": false
}
```

## `GET /admin/media/crawl/:taskId`

Poll crawl status. Returns the crawl task object with `status`, resolved content, and metadata once complete.

```bash
curl -s "$API/admin/media/crawl/$TASK_ID" \
  -H "Authorization: Bearer $KEY" | jq .
```

## `POST /admin/media/prompt`

Runs the OpenAI optimizer and returns the saved optimized image prompt. No image is generated.

Default selection behavior:

- If `optimizerConfigId` is provided, that exact config is used.
- Otherwise, if `optimizerKey` or `optimizerVersion` is provided, the matching config is used.
- Otherwise, active prompt variants are topic-routed with fallback:
  - topic/keyword match wins first
  - if nothing matches, the active fallback variant is used

Example:

```bash
curl -s "$API/admin/media/prompt" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com/article",
    "optimizerConfigId": 12
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
    "version": "v1.1-c",
    "name": "News Image Prompt Optimizer - Photojournalistic Realism",
    "optimizerProvider": "openai",
    "optimizerModel": "gpt-5.4-mini-2026-03-17",
    "generationProvider": "fal",
    "generationModel": "fal-ai/flux-2/turbo",
    "matchedTopics": ["politics"],
    "matchedKeywords": ["vote"],
    "fallbackReason": null
  },
  "optimizerInput": {
    "title": "Article title",
    "headline": "Article headline",
    "summary": "Article summary",
    "topics": ["ai", "agents"],
    "language": "en"
  },
  "resolvedContent": {
    "title": "Article title",
    "textLength": 1234,
    "textPreview": "First 300 chars of article...",
    "sourceKind": "crawl",
    "sourceUrl": "https://example.com/article",
    "metadata": {},
    "crawlProvider": "cf_browser",
    "cfError": null,
    "cfFailureKind": null
  },
  "targetStory": null,
  "promptGenerationId": 42,
  "optimizerPromptRunEventId": 99,
  "optimizerLatencyMs": 820,
  "error": null,
  "totalMs": 2450
}
```

When `dryRun` is `true`, `promptGenerationId` and `optimizerPromptRunEventId` will be `null`.

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

Response shape:

```json
{
  "status": "ready",
  "imageUrl": "https://fal.media/files/...",
  "previewId": "test-prompts/12345/run.json",
  "previewAssetUrl": "https://media.example.com/test-prompts/12345/run.webp",
  "provider": "fal",
  "model": "fal-ai/flux/schnell",
  "resolvedPrompt": "Editorial image prompt...",
  "optimizerUsed": {
    "id": 1,
    "key": "news_image_prompt_optimizer",
    "version": "v1.1-a",
    "name": "News Image Prompt Optimizer - Production Generalist",
    "optimizerProvider": "openai",
    "optimizerModel": "gpt-5.4-mini-2026-03-17",
    "generationProvider": "fal",
    "generationModel": "fal-ai/flux-2/turbo",
    "matchedTopics": [],
    "matchedKeywords": [],
    "fallbackReason": "no_topic_match"
  },
  "optimizerInput": {
    "title": "Article title",
    "headline": "Article headline",
    "summary": "Article summary",
    "topics": ["ai", "agents"],
    "language": "en"
  },
  "imageGenerationSettings": {},
  "resolvedContent": {
    "title": "Article title",
    "textLength": 1234,
    "textPreview": "First 300 chars of article...",
    "sourceKind": "crawl",
    "sourceUrl": "https://example.com/article",
    "metadata": {},
    "crawlProvider": "cf_browser",
    "cfError": null,
    "cfFailureKind": null
  },
  "targetStory": { "storyId": 12345, "..." : "..." },
  "optimizerLatencyMs": 820,
  "latencyMs": 3200,
  "totalMs": 4500,
  "error": null,
  "promptGenerationId": 42,
  "optimizerPromptRunEventId": 99,
  "imagePromptRunEventId": 100,
  "billableUnits": 1
}
```

When `applyToStory` is `true`, the generated preview is immediately applied to the existing story and the response includes:

- `applied`: `true`
- `replacedStoryContent`: whether `replaceStoryContent` was enabled
- `appliedResult`: final applied story media details

Examples:

Use stored crawl/content already in DB, generate a fresh image prompt + image, then save it to the story:

```bash
curl -s "$API/admin/media/generate" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "storyId": 12345,
    "applyToStory": true
  }' | jq .
```

Force a recrawl, fully replace stored crawl-derived content in DB, generate a fresh image prompt + image, then save it to the story:

```bash
curl -s "$API/admin/media/generate" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "storyId": 12345,
    "recrawl": true,
    "applyToStory": true,
    "replaceStoryContent": true
  }' | jq .
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

## `POST /admin/test-prompt`

Legacy all-in-one endpoint that combines prompt optimization and image generation. Has extra capabilities not available in the granular endpoints above.

### Extra request fields

| Field | Type | Notes |
| --- | --- | --- |
| `generateImage` | boolean | Set `false` to skip image generation and return prompt only. Defaults to `true` |
| `dryRun` | boolean | Return prompt-only output without saving prompt-generation rows or prompt-run events. Also forces `generateImage` off |
| `replaceStoryContent` | boolean | When applying a saved test, replace stored `story_content` fields instead of merging |
| `uploadToR2` | boolean | Upload generated image to R2 even without a `storyId` |
| `applyApprovedTest` | boolean | Set `true` to apply a previously staged test (requires `testManifestKey` or `storyId`) |
| `testManifestKey` | string | Manifest key for the apply flow |

### Response differences

The response includes all fields from `/admin/media/generate` plus:

| Field | Type | Notes |
| --- | --- | --- |
| `r2Url` | string | R2 asset URL (instead of `previewAssetUrl`) |
| `approval` | object | Present when a storyId-bound preview was staged. Contains `canApply`, `storyId`, `testManifestKey`, `testAssetKey`, `testAssetUrl` |

## Notes

- `prompt_templates`, `templateId`, and `templateText` are removed from the admin workflow.
- Prompt optimizer configs live in Supabase table `image_prompt_optimizer_configs`.
- The table now carries both optimizer and image-generation defaults:
  - `optimizer_provider`, `optimizer_model`
  - `generation_provider`, `generation_model`
- Topic routing metadata also lives on the config rows:
  - `topic_matchers`, `keyword_matchers`, `routing_priority`, `fallback`
- Seeded prompt variants are:
  - `v1.1-a`: Production Generalist
  - `v1.1-b`: Editorial Metaphor
  - `v1.1-c`: Photojournalistic Realism
- Saved optimized prompts live in Supabase table `image_prompt_generations`.
- `story_media.image_prompt` keeps the latest selected prompt mirror for the story.
- Shaped payload structure is unchanged.
