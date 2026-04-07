# Admin Test Prompt Endpoint

`POST /admin/test-prompt`

Test different image generation prompts, models, and providers without going through the full media pipeline. Useful for iterating on prompt templates locally before promoting them to production.

## Authentication

Uses a static `ADMIN_API_KEY` secret passed as a Bearer token.

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

## Request Parameters

| Field | Type | Required | Description |
|---|---|---|---|
| **Content source** (pick one) | | | |
| `storyId` | number | no | Use an existing story's cached content from the DB |
| `url` | string | no | Live-crawl this URL to get title + article text |
| `title` | string | no | Manual title (skip crawling) |
| `text` | string | no | Manual article body (skip crawling) |
| **Template** (pick one) | | | |
| `templateText` | string | no | Ad-hoc prompt template with `{{title}}` and `{{sourceText}}` placeholders |
| `templateId` | number/uuid | no | Use an existing template from the `prompt_templates` table |
| *(neither)* | | | Uses the default fallback template |
| **Provider + Model** | | | |
| `provider` | string | no | `"fal"` or `"openai"` (default: `"fal"`) |
| `model` | string | no | Model ID (default: `"fal-ai/flux-2/turbo"` for fal, `"gpt-image-1"` for openai) |
| **Generation settings** | | | |
| `settings` | object | no | Merged over defaults. See settings table below. |
| **Options** | | | |
| `uploadToR2` | boolean | no | Upload result to R2 and return permanent URL (default: `false`) |
| `logPromptRun` | boolean | no | Write to `prompt_run_events` table (default: `true`) |

### Settings object

#### fal.ai settings

| Key | Default | Options |
|---|---|---|
| `guidance_scale` | `2.5` | Any positive number |
| `image_size` | `"portrait_16_9"` | `"square"`, `"landscape_16_9"`, `"portrait_16_9"` |
| `num_images` | `1` | 1+ |
| `enable_safety_checker` | `true` | boolean |
| `output_format` | `"webp"` | `"webp"`, `"png"`, `"jpeg"` |
| `enable_prompt_expansion` | `true` | boolean |

#### OpenAI settings

| Key | Default | Options |
|---|---|---|
| `quality` | `"auto"` | `"auto"`, `"high"`, `"low"` |
| `size` | `"1024x1792"` | `"1024x1024"`, `"1792x1024"`, `"1024x1792"` |
| `background` | `"auto"` | `"auto"`, `"transparent"`, `"opaque"` |

---

## Response

```jsonc
{
  "status": "ready",              // "ready" or "failed"
  "imageUrl": "https://...",      // Direct provider image URL
  "r2Url": null,                  // Permanent R2 URL (if uploadToR2: true)
  "provider": "fal",
  "model": "fal-ai/flux-2/turbo",
  "resolvedPrompt": "Editorial illustration for news story...",
  "templateUsed": {
    "id": null,
    "name": "adhoc",
    "templateText": "..."
  },
  "settings": { ... },           // Merged settings that were actually used
  "resolvedContent": {
    "title": "Apple launches...",
    "textLength": 1200,
    "sourceKind": "crawl",       // "cache", "crawl", or "provided"
    "metadata": {                // From Cloudflare crawl AI (null if manual)
      "title": "...",
      "headline": "...",
      "language": "en",
      "summary": "...",
      "topics": ["ai", "apple"]
    }
  },
  "latencyMs": 2340,             // Image generation time
  "totalMs": 5120,               // Total request time (including crawl)
  "error": null,
  "promptRunEventId": "uuid",
  "billableUnits": 1
}
```

---

## curl Examples

### 1. Manual title + text (simplest — no crawling)

```bash
curl -s "$API/admin/test-prompt" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Apple Launches M5 Chip with 3nm Architecture",
    "text": "Apple unveiled its next-generation M5 processor featuring a 3-nanometer design with 40 billion transistors, promising 2x the performance per watt.",
    "provider": "fal",
    "model": "fal-ai/flux-2/turbo"
  }' | jq .
```

### 2. Crawl a URL and generate

```bash
curl -s "$API/admin/test-prompt" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://techcrunch.com/some-article",
    "provider": "fal"
  }' | jq .
```

### 3. Use an existing story from the DB

```bash
curl -s "$API/admin/test-prompt" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "storyId": 12345
  }' | jq .
```

### 4. Custom prompt template

```bash
curl -s "$API/admin/test-prompt" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "storyId": 12345,
    "templateText": "Minimalist vector art for a tech news story about \"{{title}}\". Clean lines, muted palette, no text overlays. Context: {{sourceText}}"
  }' | jq .
```

### 5. Compare fal vs OpenAI with same content

```bash
# fal
curl -s "$API/admin/test-prompt" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "SpaceX Starship Completes First Orbital Flight",
    "text": "SpaceX successfully launched and landed its Starship vehicle...",
    "provider": "fal",
    "model": "fal-ai/flux-2/turbo"
  }' | jq '{status, imageUrl, provider, model, latencyMs}'

# OpenAI
curl -s "$API/admin/test-prompt" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "SpaceX Starship Completes First Orbital Flight",
    "text": "SpaceX successfully launched and landed its Starship vehicle...",
    "provider": "openai",
    "model": "gpt-image-1"
  }' | jq '{status, imageUrl, provider, model, latencyMs}'
```

### 6. Use a DB template by ID

```bash
curl -s "$API/admin/test-prompt" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "storyId": 12345,
    "templateId": 7
  }' | jq .
```

### 7. Override model on a DB template

```bash
curl -s "$API/admin/test-prompt" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "storyId": 12345,
    "templateId": 7,
    "model": "fal-ai/flux-pro/v1.1"
  }' | jq .
```

### 8. Tune generation settings

```bash
curl -s "$API/admin/test-prompt" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "AI Regulation Bill Passes Senate",
    "text": "The US Senate passed a comprehensive AI regulation bill...",
    "settings": {
      "guidance_scale": 5.0,
      "image_size": "landscape_16_9",
      "enable_prompt_expansion": false
    }
  }' | jq .
```

### 9. OpenAI with high quality + square

```bash
curl -s "$API/admin/test-prompt" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Neural Interface Breakthrough",
    "text": "Researchers demonstrated a non-invasive brain-computer interface...",
    "provider": "openai",
    "model": "gpt-image-1",
    "settings": {
      "quality": "high",
      "size": "1024x1024"
    }
  }' | jq .
```

### 10. Upload to R2 for permanent URL

```bash
curl -s "$API/admin/test-prompt" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "storyId": 12345,
    "uploadToR2": true
  }' | jq '{status, imageUrl, r2Url}'
```

### 11. Skip logging (quick iteration)

```bash
curl -s "$API/admin/test-prompt" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Test prompt iteration",
    "text": "Quick test content...",
    "templateText": "Photorealistic editorial photo: {{title}}. {{sourceText}}",
    "logPromptRun": false
  }' | jq '{status, imageUrl, latencyMs}'
```

### 12. Crawl URL + custom template + OpenAI

```bash
curl -s "$API/admin/test-prompt" \
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
    },
    "uploadToR2": true
  }' | jq .
```

---

## Workflow

1. **Start local dev**: `npm run dev` (starts API worker on localhost:8787)
2. **Set your key**: Add `ADMIN_API_KEY=my-secret` to `.dev.vars`
3. **Iterate**: POST different templates/models/settings, compare `imageUrl` results
4. **Promote**: Once happy, insert the winning template into `prompt_templates` via Supabase and set `active = true`
5. **Review**: Check `prompt_run_events` table to compare latency and quality across runs

## Error Responses

| Status | Meaning |
|---|---|
| 400 | Invalid JSON or no content provided |
| 401 | Missing/invalid `ADMIN_API_KEY` |
| 404 | `templateId` not found |
| 422 | URL crawl failed (details in `crawlError`) |
| 503 | `ADMIN_API_KEY` not configured on the worker |
