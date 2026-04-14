# Admin Media API

Complete set of endpoints for testing, previewing, generating, saving, and updating AI media for stories.

## Authentication

All admin endpoints use a static `ADMIN_API_KEY` secret passed as a Bearer token.

```bash
# Add to your .dev.vars:
ADMIN_API_KEY=my-local-secret

# Add to production/staging via wrangler:
# wrangler secret put ADMIN_API_KEY --config workers/api/wrangler.jsonc
```

All examples below assume:

```bash
export API=http://localhost:8787
export KEY=my-local-secret
```

---

## Endpoint Overview

| # | Method | Path | Purpose |
|---|--------|------|---------|
| 1 | `POST` | `/admin/media/prompt` | Resolve content + return exact prompt (no image) |
| 2 | `POST` | `/admin/media/generate` | Generate image + stage preview with `previewId` |
| 3 | `POST` | `/admin/media/save` | Save a staged preview as a **new** story |
| 4 | `PUT` | `/admin/media/:storyId` | Apply a staged preview to an **existing** story |

Pipeline steps each endpoint covers:

```
resolve content → build prompt → generate image → stage preview → persist
───────────────────────────────
  /admin/media/prompt    (1→2)
  /admin/media/generate  (1→2→3→4)
  /admin/media/save      (5: new story)
  /admin/media/:storyId  (5: existing story)
```

---

## Shared Parameters (endpoints 1 & 2)

### Content source (pick one or combine)

| Field | Type | Description |
|-------|------|-------------|
| `storyId` | number | Use an existing story's cached content from the DB |
| `url` | string | Live-crawl this URL to get title + article text |
| `title` | string | Manual title (skip crawling) |
| `text` | string | Manual article body (skip crawling) |

When `storyId` is provided with `url`, the URL is used as a crawl source if the DB cache is empty (or if `recrawl` is set).

### Crawl control

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `recrawl` | boolean | `false` | Force re-crawl even if cached content exists for the story. Ignored when no `storyId` is provided. |

### Template (pick one)

| Field | Type | Description |
|-------|------|-------------|
| `templateText` | string | Ad-hoc prompt template with `{{title}}` and `{{sourceText}}` placeholders |
| `templateId` | number/uuid | Use an existing template from the `prompt_templates` table |
| *(neither)* | | Uses the default fallback template |

### Provider + Model

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `provider` | string | `"fal"` | `"fal"` or `"openai"` |
| `model` | string | auto | Model ID (default: `"fal-ai/flux-2/turbo"` for fal, `"gpt-image-1"` for openai) |
| `settings` | object | `{}` | Merged over defaults. See settings tables below. |

### Settings object

#### fal.ai settings

| Key | Default | Options |
|-----|---------|---------|
| `guidance_scale` | `2.5` | Any positive number |
| `image_size` | `"portrait_16_9"` | `"square"`, `"landscape_16_9"`, `"portrait_16_9"` |
| `num_images` | `1` | 1+ |
| `enable_safety_checker` | `true` | boolean |
| `output_format` | `"webp"` | `"webp"`, `"png"`, `"jpeg"` |
| `enable_prompt_expansion` | `true` | boolean |

#### OpenAI settings

| Key | Default | Options |
|-----|---------|---------|
| `quality` | `"auto"` | `"auto"`, `"high"`, `"low"` |
| `size` | `"1024x1792"` | `"1024x1024"`, `"1792x1024"`, `"1024x1792"` |
| `background` | `"auto"` | `"auto"`, `"transparent"`, `"opaque"` |

---

## 1. `POST /admin/media/prompt`

Resolve content and return the exact prompt that would be sent to the image generation provider. No image is generated, no credits spent.

### Response

```jsonc
{
  "status": "resolved",
  "resolvedPrompt": "Editorial illustration for news story \"Apple Launches M5\"...",
  "templateUsed": {
    "id": null,
    "name": "adhoc",
    "templateText": "..."
  },
  "settings": { "guidance_scale": 2.5, "image_size": "portrait_16_9", ... },
  "resolvedContent": {
    "title": "Apple Launches M5 Chip",
    "textLength": 1200,
    "textPreview": "First 1200 chars of article text...",
    "sourceKind": "cache",       // "cache", "crawl", or "provided"
    "sourceUrl": "https://example.com/article",
    "metadata": {                // From crawl AI extraction (null if manual/cache without crawl)
      "title": "...",
      "headline": "...",
      "language": "en",
      "summary": "...",
      "topics": ["ai", "apple"]
    }
  },
  "targetStory": {               // null if no storyId provided
    "storyId": 12345,
    "publishSequence": 77,
    "sourceEndpoint": "tech",
    "publishedAt": "2026-04-08T10:00:00.000Z",
    "mediaUrl": "https://media.newsroll.app/stories/old.webp",
    "mediaStatus": "ready",
    "headline": "Current headline"
  },
  "totalMs": 120
}
```

### curl Examples

#### Get prompt for an existing story (from DB cache)

```bash
curl -s "$API/admin/media/prompt" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "storyId": 12345
  }' | jq .
```

#### Get prompt for a story with forced re-crawl

```bash
curl -s "$API/admin/media/prompt" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "storyId": 12345,
    "recrawl": true
  }' | jq .
```

#### Dry-run: crawl a URL and see the prompt

```bash
curl -s "$API/admin/media/prompt" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://techcrunch.com/some-article"
  }' | jq .
```

#### Dry-run with a specific DB template

```bash
curl -s "$API/admin/media/prompt" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://techcrunch.com/some-article",
    "templateId": 7
  }' | jq .
```

#### Dry-run with ad-hoc template and manual content

```bash
curl -s "$API/admin/media/prompt" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "SpaceX Starship Completes First Orbital Flight",
    "text": "SpaceX successfully launched and landed its Starship vehicle...",
    "templateText": "Minimalist vector art for \"{{title}}\". Clean lines, muted palette. Context: {{sourceText}}"
  }' | jq .
```

#### Dry-run with OpenAI provider override

```bash
curl -s "$API/admin/media/prompt" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "storyId": 12345,
    "provider": "openai",
    "model": "gpt-image-1"
  }' | jq .
```

#### Story with URL fallback (use cache, crawl URL only if cache is empty)

```bash
curl -s "$API/admin/media/prompt" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "storyId": 12345,
    "url": "https://example.com/article"
  }' | jq .
```

#### Story with URL + forced re-crawl (ignore cache, always crawl)

```bash
curl -s "$API/admin/media/prompt" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "storyId": 12345,
    "url": "https://example.com/article",
    "recrawl": true
  }' | jq .
```

---

## 2. `POST /admin/media/generate`

Resolve content, build prompt, generate image, and stage the result in R2 as a preview. Returns a `previewId` that can be used with `/admin/media/save` or `/admin/media/:storyId` to persist the result.

### Additional Parameters

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `logPromptRun` | boolean | `true` | Write to `prompt_run_events` table |

### Response

```jsonc
{
  "status": "ready",              // "ready" or "failed"
  "imageUrl": "https://...",      // Direct provider image URL
  "previewId": "test-prompts/12345/a1b2c3.json",   // Use this to save or apply later
  "previewAssetUrl": "https://media.newsroll.app/test-prompts/12345/a1b2c3.webp",
  "provider": "fal",
  "model": "fal-ai/flux-2/turbo",
  "resolvedPrompt": "Editorial illustration for news story...",
  "templateUsed": {
    "id": null,
    "name": "adhoc",
    "templateText": "..."
  },
  "settings": { ... },
  "resolvedContent": {
    "title": "Apple Launches M5 Chip",
    "textLength": 1200,
    "textPreview": "First 1200 chars...",
    "sourceKind": "cache",
    "sourceUrl": "https://example.com/article",
    "metadata": { ... }
  },
  "targetStory": { ... },        // null if no storyId
  "latencyMs": 2340,             // Image generation time
  "totalMs": 5120,               // Total request time (including crawl)
  "error": null,
  "promptRunEventId": "uuid",
  "billableUnits": 1
}
```

### curl Examples

#### Generate media for an existing story

```bash
curl -s "$API/admin/media/generate" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "storyId": 12345
  }' | jq .
```

#### Generate with forced re-crawl

```bash
curl -s "$API/admin/media/generate" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "storyId": 12345,
    "recrawl": true
  }' | jq .
```

#### Generate from a URL (no existing story)

```bash
curl -s "$API/admin/media/generate" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://techcrunch.com/some-article",
    "provider": "fal"
  }' | jq .
```

#### Generate with manual content

```bash
curl -s "$API/admin/media/generate" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Apple Launches M5 Chip with 3nm Architecture",
    "text": "Apple unveiled its next-generation M5 processor...",
    "provider": "fal",
    "model": "fal-ai/flux-2/turbo"
  }' | jq .
```

#### Generate with custom template

```bash
curl -s "$API/admin/media/generate" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "storyId": 12345,
    "templateText": "Cinematic wide-angle shot illustrating \"{{title}}\". Dramatic lighting, photojournalism style. {{sourceText}}"
  }' | jq .
```

#### Generate with DB template + model override

```bash
curl -s "$API/admin/media/generate" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "storyId": 12345,
    "templateId": 7,
    "model": "fal-ai/flux-pro/v1.1"
  }' | jq .
```

#### Generate with custom settings

```bash
curl -s "$API/admin/media/generate" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "storyId": 12345,
    "settings": {
      "guidance_scale": 5.0,
      "image_size": "landscape_16_9",
      "enable_prompt_expansion": false
    }
  }' | jq .
```

#### Generate with OpenAI

```bash
curl -s "$API/admin/media/generate" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "storyId": 12345,
    "provider": "openai",
    "model": "gpt-image-1",
    "settings": {
      "quality": "high",
      "size": "1024x1024"
    }
  }' | jq .
```

#### Compare fal vs OpenAI side by side

```bash
# fal
curl -s "$API/admin/media/generate" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "storyId": 12345,
    "provider": "fal"
  }' | jq '{status, imageUrl, previewId, provider, model, latencyMs}'

# OpenAI
curl -s "$API/admin/media/generate" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "storyId": 12345,
    "provider": "openai"
  }' | jq '{status, imageUrl, previewId, provider, model, latencyMs}'
```

#### Generate without logging (quick iteration)

```bash
curl -s "$API/admin/media/generate" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Test prompt iteration",
    "text": "Quick test content...",
    "templateText": "Photorealistic editorial photo: {{title}}. {{sourceText}}",
    "logPromptRun": false
  }' | jq '{status, imageUrl, previewId, latencyMs}'
```

#### Generate from URL + custom template + OpenAI

```bash
curl -s "$API/admin/media/generate" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com/article",
    "templateText": "Cinematic wide-angle shot illustrating \"{{title}}\". Dramatic lighting, photojournalism style. {{sourceText}}",
    "provider": "openai",
    "model": "gpt-image-1",
    "settings": {
      "quality": "high",
      "size": "1792x1024"
    }
  }' | jq .
```

---

## 3. `POST /admin/media/save`

Save a previously staged preview as a brand-new story. Creates `feed_entries`, `story_media`, `story_content`, and `published_feed_entries` records. Syncs with Shaped for personalization.

### Parameters

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `previewId` | string | yes | The `previewId` returned by `/admin/media/generate` |
| `category` | string | no | Feed category for the new story (e.g. `"tech"`, `"science"`). Falls back to the preview's `sourceEndpoint` or `"general"`. |

### Response

```jsonc
{
  "ok": true,
  "storyId": 99999,
  "saved": true,
  "previewId": "test-prompts/12345/a1b2c3.json",
  "mediaKey": "stories/99999-abcdef.webp",
  "mediaUrl": "https://media.newsroll.app/stories/99999-abcdef.webp",
  "publishedEntry": {
    "storyId": 99999,
    "publishSequence": 142,
    "publishedAt": "2026-04-14T10:00:00.000Z",
    "sourceEndpoint": "tech",
    "mediaStatus": "ready",
    "headline": "Apple Launches M5 Chip"
  },
  "contentUpdated": {
    "readableContent": true,
    "headline": true,
    "summary": true,
    "topics": 3
  }
}
```

### curl Examples

#### Save a preview as a new tech story

```bash
curl -s "$API/admin/media/save" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "previewId": "test-prompts/12345/a1b2c3.json",
    "category": "tech"
  }' | jq .
```

#### Save with default category

```bash
curl -s "$API/admin/media/save" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "previewId": "test-prompts/adhoc/d4e5f6.json"
  }' | jq .
```

---

## 4. `PUT /admin/media/:storyId`

Apply a previously staged preview to an existing story. Updates `story_media`, `story_content`, `published_feed_entries`, headline, and summary. Refreshes the feed snapshot and syncs with Shaped.

### Parameters

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `previewId` | string | yes | The `previewId` returned by `/admin/media/generate` |

The `:storyId` in the path identifies the target story to update.

### Response

```jsonc
{
  "ok": true,
  "storyId": 12345,
  "applied": true,
  "previewId": "test-prompts/12345/a1b2c3.json",
  "mediaKey": "stories/12345-abcdef.webp",
  "mediaUrl": "https://media.newsroll.app/stories/12345-abcdef.webp",
  "publishedEntry": {
    "storyId": 12345,
    "publishSequence": 77,
    "publishedAt": "2026-04-08T10:00:00.000Z",
    "sourceEndpoint": "tech",
    "mediaStatus": "ready",
    "headline": "Updated headline from crawl"
  },
  "contentUpdated": {
    "readableContent": true,
    "headline": true,
    "summary": true,
    "topics": 3
  },
  "shaped": { "ok": true }
}
```

### curl Examples

#### Apply a preview to an existing story

```bash
curl -s -X PUT "$API/admin/media/12345" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "previewId": "test-prompts/12345/a1b2c3.json"
  }' | jq .
```

#### Full workflow: generate then apply

```bash
# Step 1: generate and capture the previewId
PREVIEW_ID=$(curl -s "$API/admin/media/generate" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "storyId": 12345,
    "recrawl": true,
    "templateId": 7
  }' | jq -r '.previewId')

echo "Preview: $PREVIEW_ID"

# Step 2: inspect the preview image at the returned previewAssetUrl, then apply
curl -s -X PUT "$API/admin/media/12345" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"previewId\": \"$PREVIEW_ID\"
  }" | jq .
```

---

## Complete Workflows

### Workflow A: Test prompt for a story, then generate and apply

```bash
# 1. Check what prompt the story would get
curl -s "$API/admin/media/prompt" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"storyId": 12345}' | jq '{resolvedPrompt, resolvedContent, settings}'

# 2. Try with a different template
curl -s "$API/admin/media/prompt" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "storyId": 12345,
    "templateText": "Minimalist vector art for \"{{title}}\". Clean lines, muted palette. {{sourceText}}"
  }' | jq '{resolvedPrompt}'

# 3. Happy with prompt — generate the image
PREVIEW_ID=$(curl -s "$API/admin/media/generate" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "storyId": 12345,
    "templateText": "Minimalist vector art for \"{{title}}\". Clean lines, muted palette. {{sourceText}}"
  }' | jq -r '.previewId')

# 4. Apply to the story
curl -s -X PUT "$API/admin/media/12345" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d "{\"previewId\": \"$PREVIEW_ID\"}" | jq .
```

### Workflow B: Crawl a URL and create a new story

```bash
# 1. Dry-run: crawl and check content + prompt
curl -s "$API/admin/media/prompt" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/breaking-news"}' \
  | jq '{resolvedPrompt, resolvedContent}'

# 2. Generate image from the URL
PREVIEW_ID=$(curl -s "$API/admin/media/generate" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/breaking-news"}' \
  | jq -r '.previewId')

# 3. Save as a new story in the "general" category
curl -s "$API/admin/media/save" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d "{\"previewId\": \"$PREVIEW_ID\", \"category\": \"general\"}" | jq .
```

### Workflow C: Re-crawl a stale story and update its media

```bash
# 1. Check current state vs fresh crawl
curl -s "$API/admin/media/prompt" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"storyId": 12345}' | jq '.resolvedContent.sourceKind'
# → "cache" (stale)

curl -s "$API/admin/media/prompt" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"storyId": 12345, "recrawl": true}' | jq '.resolvedContent'
# → sourceKind: "crawl", fresh metadata

# 2. Generate with fresh content
PREVIEW_ID=$(curl -s "$API/admin/media/generate" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"storyId": 12345, "recrawl": true}' | jq -r '.previewId')

# 3. Apply
curl -s -X PUT "$API/admin/media/12345" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d "{\"previewId\": \"$PREVIEW_ID\"}" | jq .
```

### Workflow D: A/B test two providers, pick the winner

```bash
# Generate with fal
FAL_RESULT=$(curl -s "$API/admin/media/generate" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"storyId": 12345, "provider": "fal"}')
FAL_PREVIEW=$(echo "$FAL_RESULT" | jq -r '.previewId')
FAL_IMAGE=$(echo "$FAL_RESULT" | jq -r '.previewAssetUrl')

# Generate with OpenAI
OAI_RESULT=$(curl -s "$API/admin/media/generate" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"storyId": 12345, "provider": "openai"}')
OAI_PREVIEW=$(echo "$OAI_RESULT" | jq -r '.previewId')
OAI_IMAGE=$(echo "$OAI_RESULT" | jq -r '.previewAssetUrl')

echo "FAL:    $FAL_IMAGE"
echo "OpenAI: $OAI_IMAGE"

# Compare images, then apply the winner
curl -s -X PUT "$API/admin/media/12345" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d "{\"previewId\": \"$FAL_PREVIEW\"}" | jq .
```

---

## Error Responses

| Status | Meaning |
|--------|---------|
| 400 | Invalid JSON, missing required field, or no content provided |
| 401 | Missing or invalid `ADMIN_API_KEY` |
| 404 | `templateId` not found, story not found, or preview manifest not found |
| 409 | `storyId` in request body doesn't match the preview manifest |
| 422 | URL crawl failed (details in `resolvedContent.metadata` or `error`) |
| 503 | `ADMIN_API_KEY` not configured, or `MEDIA_BUCKET` binding missing |

---

## Legacy Endpoint

`POST /admin/test-prompt` remains available for backward compatibility. It combines prompt resolution, image generation, and the apply flow in a single endpoint. See git history for its original documentation. New integrations should use the endpoints above.

---

## Local Development

1. **Start local dev**: `npm run dev` (starts API worker on localhost:8787)
2. **Set your key**: Add `ADMIN_API_KEY=my-local-secret` to `.dev.vars`
3. **Test prompt**: Use `/admin/media/prompt` to inspect resolved content and prompt before spending image credits
4. **Generate preview**: Use `/admin/media/generate` — inspect `previewAssetUrl` in a browser
5. **Apply or save**: Use `PUT /admin/media/:storyId` to overwrite an existing story, or `POST /admin/media/save` to create a new one
