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
- upsert item metadata whenever enrichment/velocity changes
- start with a simple engine that works even before model training
- add collaborative filtering once interaction volume is meaningful

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

- a story is first enriched
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
- `ai_thread_intelligence_request`

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
- `topics_text`
- `entities_text`
- `publisher`
- `source_endpoint`

Strong ranking features for NewsRoll:

- `quality_score`
- `novelty_score`
- `publisher_tier`
- `source_reliability_score`
- `ctr_5m`
- `ctr_30m`
- `ctr_2h`
- `save_rate_2h`
- `skip_rate_30m`
- `completion_rate_2h`

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
- `position`
- `feed_mode`
- `media_type`
- `source_endpoint`
- `topic_primary`
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
- `ai_thread_intelligence_request`: `0.7`

Adjust these after observing feed behavior. For news, over-weighting impressions usually hurts quality because passive exposure is not strong preference.

## Best practices for this use case

### 1. Keep items denormalized

Shaped works best when the item table already contains the ranking/search fields you care about. Do not depend on runtime joins if you can avoid it.

### 2. Add text-ready columns

For text search and semantic retrieval, store flattened strings such as:

- `topics_text`
- `entities_text`

instead of relying only on arrays.

### 3. Use real-time events, not batch-only interactions

For a news app, interaction freshness matters. Push events continuously.

### 4. Keep the current local fallback

Do not make Shaped your only ranking path until:

- the engine is `ACTIVE`
- event volume is healthy
- you have observed stable output quality

### 5. Version engines, not tables

Tables should remain stable. Most ranking experimentation should happen in versioned engine YAML files.

## Suggested next code changes

The current worker integration is expected to use:

1. `SHAPED_ENGINE_NAME=newsroll_visual_v1`
2. `SHAPED_ITEMS_TABLE=newsroll_items`
3. `SHAPED_INTERACTIONS_TABLE=newsroll_interactions`
4. `POST /v2/tables/{table}/insert` with JSON `{"data":[...]}` for streaming items and interactions
5. `POST /v2/engines/{engine}/query` with a ShapedQL candidate-ID reranking query

Treat this folder as the source of truth for Shaped provisioning and engine evolution.
