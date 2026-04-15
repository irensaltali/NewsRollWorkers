# Admin Story Data API

Returns the current stored state for a story across the admin-facing tables.

## Authentication

All admin endpoints require `ADMIN_API_KEY` as a Bearer token.

```bash
export API=http://localhost:8787
export KEY=my-local-secret
```

## Endpoint

`GET /admin/stories/:storyId`

Returns the current data found for the story in:

- `published_feed_entries`
- `story_content`
- `story_media`
- RSS source metadata from `rss_items` and `rss_sources`

If no current state is found in any of those sources, the endpoint returns `404`.

## Example

```bash
curl -s "$API/admin/stories/12345" \
  -H "Authorization: Bearer $KEY" | jq .
```

Example response:

```json
{
  "storyId": 12345,
  "publishedEntry": {
    "storyId": 12345,
    "publishSequence": 77,
    "sourceEndpoint": "tech",
    "publishedAt": "2026-04-15T09:00:00Z",
    "mediaStatus": "ready",
    "headline": "Published headline",
    "mediaType": "image",
    "mediaProvider": "fal",
    "mediaModel": "fal-ai/flux-2/turbo",
    "generationStatus": "ready",
    "generationLatencyMs": 2345,
    "generationCostUsd": 0.02,
    "engagementCount": 15,
    "impressionCount": 120
  },
  "storyContent": {
    "storyId": 12345,
    "sourceKind": "crawl",
    "extractedText": "Current extracted story text",
    "aiHeadline": "AI headline",
    "sourceUrl": "https://example.com/story",
    "feedUrl": "https://example.com/feed.xml",
    "summary": "Current summary",
    "explanation": "Current explanation",
    "explanationJson": {
      "title": "Explain title",
      "sections": []
    },
    "topics": ["ai", "media"],
    "updatedAt": "2026-04-15T09:05:00Z"
  },
  "storyMedia": {
    "storyId": 12345,
    "status": "ready",
    "falRequestId": "fal-request-1",
    "mediaKey": "stories/12345-hash.webp",
    "mediaUrl": "https://media.example.com/story.webp",
    "failureReason": null,
    "attempts": 1,
    "imagePrompt": "Current image prompt",
    "imagePromptGenerationId": 91,
    "optimizerConfigId": 7,
    "mediaType": "image",
    "provider": "fal",
    "model": "fal-ai/flux-2/turbo",
    "generationLatencyMs": 2345,
    "updatedAt": "2026-04-15T09:06:00Z"
  },
  "sourceMetadata": {
    "url": "https://example.com/story",
    "canonicalUrl": "https://example.com/story-canonical",
    "feedUrl": "https://example.com/feed.xml"
  }
}
```

`storyMedia.mediaUrl` is the canonical media URL. The admin response does not duplicate that URL under `publishedEntry`.
