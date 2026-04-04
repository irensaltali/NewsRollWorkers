# Shaped Setup for NewsRoll

This folder defines the Shaped 2.0 setup for NewsRoll's personalized visual feed.

The recommended architecture for this repo is:

1. Use a custom Shaped `items` table for article/feed metadata.
2. Use a custom Shaped `interactions` table for real-time user-item events.
3. Build a single engine for personalized ranking and cold-start retrieval.
4. Version engine YAML files when you make breaking ranking changes.

## Why this fits NewsRoll

NewsRoll is a fast-moving content feed with:

- frequent new item creation
- short content half-life
- strong implicit-feedback signals
- sparse user profiles early on

For that shape of product, the best Shaped usage is:

- stream interactions in real time
- upsert item metadata whenever stories publish or metadata changes
- start with a content-plus-trending engine that works before model training
- add collaborative retrieval once interaction volume is meaningful

Shaped's v2 engines can rank items from just an interaction table. That means you can get popularity/trending behavior immediately, then improve personalization with trained models as data accumulates.

## Files

- `tables/newsroll_items.schema.yaml`
- `tables/newsroll_interactions.schema.yaml`
- `engines/newsroll_visual_v1.yaml`

## Recommended rollout

### Phase 1: Provision tables and engine

```bash
cd NewsRollWorkers
shaped init --api-key <SHAPED_API_KEY>

shaped create-table --file shaped/tables/newsroll_items.schema.yaml
shaped create-table --file shaped/tables/newsroll_interactions.schema.yaml

shaped create-engine --file shaped/engines/newsroll_visual_v1.yaml
shaped list-engines
shaped view-engine --engine-name newsroll_visual_v1
```

### Phase 2: Stream production data

Item upserts should happen when:

- a story is first published
- velocity metrics change materially
- metadata changes that affect ranking/search

Interaction inserts should happen for:

- `impression`
- `dwell`
- `complete`
- `vote`
- `save`
- `share`
- `skip`
- `hide`
- `detail_open`
- `external_open`
- `ai_summary_request`
- `ai_explain_request`
- `ai_translate_request`

### Phase 3: Keep engine config in Git

Use this folder as your migration history:

- additive or tuning-only change: edit `newsroll_visual_v1.yaml` and run `shaped update-engine --file ...`
- breaking change: create `newsroll_visual_v2.yaml`, deploy it separately, validate, then switch traffic

## Recommended data mapping

### Items table

Keep one row per story/item. Recommended required fields:

- `item_id`
- `created_at`
- `updated_at`
- `headline`
- `title`
- `summary`
- `category`
- `topics`
- `media_type`

### Interactions table

Keep one row per user-item interaction. Include:

- `event_id`
- `user_id`
- `item_id`
- `created_at`
- `event_type`
- `label`

Additional ranking context:

- `dwell_ms`
- `session_id`
- `surface`
- `feed_mode`
- `media_type`
- `ai_action`

## Recommended event labels

Use explicit numeric labels so the engine does not have to infer signal strength from raw event names:

- `hide`: `-2.0`
- `skip`: `-1.0`
- `impression`: `0.05`
- `dwell`: `0.10` to `0.75` based on dwell time
- `complete`: `1.0`
- `vote`: `2.0`
- `save`: `2.0`
- `share`: `2.0`
- `detail_open`: `1.0`
- `external_open`: `1.25`
- `ai_summary_request`: `0.6`
- `ai_explain_request`: `0.8`
- `ai_translate_request`: `0.5`

Adjust these after observing feed behavior. For news, over-weighting impressions usually hurts quality because passive exposure is not strong preference.

## Best practices for this use case

### 1. Keep items denormalized

Shaped works best when the item table already contains the ranking/search fields you care about. Do not depend on runtime joins if you can avoid it.

For NewsRoll, that means the item row should already include the content features you want to embed and filter on:

- `headline`
- `title`
- `summary`
- `topics`
- `category`

### 2. Use real-time events, not batch-only interactions

For a news app, interaction freshness matters. Push events continuously.

### 3. Keep the current local fallback

Do not make Shaped your only ranking path until:

- the engine is `ACTIVE`
- event volume is healthy
- you have observed stable output quality

### 4. Version engines, not tables

Tables should remain stable. Most ranking experimentation should happen in versioned engine YAML files.

## Current engine shape

`newsroll_visual_v1` is intentionally a launch-safe engine:

- lexical + dense item indexing over `headline`, `title`, `summary`, `category`, and `topics`
- an `exclude_seen` personal filter backed by the interaction table
- a `trending_feed` query for anonymous/new-user fallback
- a `personalized_trending_feed` query that blends recency with content similarity to recent interactions
- a `rerank_candidates` query for candidate-ID reranking from the existing backend feed pipeline

The saved queries are written in ShapedQL directly rather than the structured query object format. This is intentional: the live Shaped v2 validator currently accepts the SQL-form saved queries more reliably than the object form shown in some docs examples.

This is the right starting point for NewsRoll because news relevance is dominated by freshness plus topical fit. Collaborative retrieval should come in `newsroll_visual_v2` after interaction volume is high enough to support it.

## Suggested next code changes

The current worker integration is expected to use:

1. `SHAPED_ENGINE_NAME=newsroll_visual_v1`
2. `SHAPED_ITEMS_TABLE=newsroll_items`
3. `SHAPED_INTERACTIONS_TABLE=newsroll_interactions`
4. `POST /v2/tables/{table}/insert` with JSON `{"data":[...]}` for streaming items and interactions
5. `POST /v2/engines/{engine}/queries/{query_name}` using one of these saved queries:
   - `trending_feed` for anonymous/new-user fallback
   - `personalized_trending_feed` for in-session personalized feed ranking
   - `rerank_candidates` for backend candidate-ID reranking

Treat this folder as the source of truth for Shaped provisioning and engine evolution.
