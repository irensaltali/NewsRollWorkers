import {
  storeStory,
  storeHeadline,
  storeStorySummary,
  createPromptRunEvent,
  upsertMedia,
  updatePublishedFeedEntryMediaProjection,
  getRandomActivePromptTemplate,
  reserveMediaQueueSlot,
  releaseMediaQueueSlot
} from "./db.mjs";
import {
  publicMediaUrlFor,
  MEDIA_MAX_QUEUE_RETRIES,
  MEDIA_DAILY_LIMIT_DEFAULT,
  MEDIA_PER_RUN_LIMIT_DEFAULT,
  MEDIA_MIN_SCORE_DEFAULT
} from "./config.mjs";
import { resolveArticleContent } from "./article-content.mjs";
import { publishReadyStoryViaCoordinator } from "./global-visual-feed-coordinator.mjs";
import { enrichPublishedStory } from "./enrichment.mjs";
import { ingestCategory } from "./rss-ingest.mjs";
import * as log from "./log.mjs";
import * as shaped from "./shaped.mjs";
import { readableUrlFor } from "./visual-feed.mjs";
import { buildFalImageRequest, generateImageWithProvider } from "./media-generation.mjs";
import { buildPromptInput, clipPromptText, mediaTemplateWithFallback } from "./prompt-config.mjs";

export { buildFalImageRequest } from "./media-generation.mjs";

async function hashText(text) {
  const buffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}


export function dailyMediaLimit(env) {
  const envVar = env.MEDIA_DAILY_LIMIT
    ?? (env.ENVIRONMENT === "staging" ? (env.STAGING_MEDIA_DAILY_LIMIT ?? "10") : null);
  if (envVar === null) {
    return MEDIA_DAILY_LIMIT_DEFAULT;
  }
  const parsed = Number.parseInt(envVar, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : MEDIA_DAILY_LIMIT_DEFAULT;
}

export function mediaPerRunLimit(env) {
  const envVar = env?.MEDIA_PER_RUN_LIMIT
    ?? (env?.ENVIRONMENT === "staging" ? "1" : null);
  if (envVar === null) {
    return MEDIA_PER_RUN_LIMIT_DEFAULT;
  }
  const parsed = Number.parseInt(envVar, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : MEDIA_PER_RUN_LIMIT_DEFAULT;
}

export function meetsMediaQualityGate(env, _category, story) {
  const minScore = Number.parseInt(env?.MEDIA_MIN_SCORE ?? "", 10);
  const threshold = Number.isFinite(minScore) && minScore >= 0 ? minScore : MEDIA_MIN_SCORE_DEFAULT;
  return (story.score ?? 0) >= threshold;
}

export function needsMediaCrawl(messageBody, resolvedArticle) {
  return Boolean(messageBody?.url) && !normalizeResolvedText(resolvedArticle?.text);
}

function normalizeResolvedText(value) {
  return typeof value === "string" ? value.trim() : "";
}

async function enqueueStoryForMedia(env, endpoint, story) {
  const reserved = await reserveMediaQueueSlot(env, {
    storyId: story.id,
    updatedAt: new Date().toISOString(),
    dailyLimit: dailyMediaLimit(env)
  });

  if (!reserved) {
    log.debug({ event: "media_enqueue_skip", storyId: story.id, endpoint });
    return false;
  }

  try {
    await env.MEDIA_QUEUE.send({
      storyId: story.id,
      endpoint,
      url: story.url ?? null,
      title: story.title ?? ""
    });
    log.debug({ event: "media_enqueue_ok", storyId: story.id, endpoint });
    return true;
  } catch (err) {
    await releaseMediaQueueSlot(env, story.id);
    throw err;
  }
}

export async function ingestStories(env, category, options = {}) {
  return ingestCategory(env, category, options);
}

function generatePrompt(template, payload) {
  const normalized = mediaTemplateWithFallback(template, "image");
  return buildPromptInput(normalized.templateText, {
    title: payload.title,
    sourceText: clipPromptText(payload.extractedText, 1200)
  });
}

function maxQueueRetries(env) {
  const parsed = Number.parseInt(env?.MEDIA_MAX_QUEUE_RETRIES ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : MEDIA_MAX_QUEUE_RETRIES;
}

export async function processMediaMessage(batch, env) {
  const maxRetries = maxQueueRetries(env);

  for (const message of batch.messages) {
    const storyId = message.body?.storyId;
    const attempt = message.attempts ?? 0;
    const msgStart = Date.now();

    if (attempt >= maxRetries) {
      log.error({
        event: "media_msg_dead_letter",
        storyId,
        attempts: attempt,
        maxRetries
      });
      await upsertMedia(env, {
        storyId,
        status: "dead_letter",
        falRequestId: null,
        mediaKey: null,
        mediaUrl: null,
        failureReason: `Exceeded max retries (${maxRetries})`,
        attempts: attempt,
        updatedAt: new Date().toISOString(),
        promptTemplateId: null,
        imagePrompt: null
      });
      message.ack();
      continue;
    }

    try {
      const body = message.body;
      const now = new Date().toISOString();
      const fallbackText = `${body.title ?? ""} ${body.url ?? ""}`.trim() || "News story";
      let resolvedArticle = await resolveArticleContent(env, storyId, {
        title: body.title ?? "",
        url: body.url ?? null
      }, {
        allowCrawl: false
      });

      if (needsMediaCrawl(body, resolvedArticle)) {
        resolvedArticle = await resolveArticleContent(env, storyId, {
          title: body.title ?? "",
          url: body.url ?? null
        });
      }

      const crawlMetadata = resolvedArticle.metadata && typeof resolvedArticle.metadata === "object"
        ? resolvedArticle.metadata
        : null;
      const title = crawlMetadata?.title ?? body.title ?? "Story";
      const extractedText = resolvedArticle.text || fallbackText;
      const sourceKind = resolvedArticle.sourceKind ?? (body.url ? "article" : "hn_text");
      if (resolvedArticle.sourceKind === "crawl") {
        const crawlChars = resolvedArticle.text.length;
        log.info({ event: "crawl_ok", storyId, chars: crawlChars });
        if (crawlChars < 100) {
          log.warn({ event: "crawl_low_quality", storyId, chars: crawlChars, url: body.url ?? null });
        }
      } else if (body.url && !resolvedArticle.text) {
        log.warn({ event: "crawl_fail", storyId, error: "empty_resolved_article_text" });
      }

      const contentHash = await hashText(extractedText);

      const headline = crawlMetadata?.headline ?? null;
      if (headline) {
        try {
          await storeHeadline(env, body.storyId, headline, null);
          log.info({ event: "headline_ok", storyId, chars: headline.length, source: "crawl" });
        } catch (err) {
          log.warn({ event: "headline_store_fail", storyId, ...log.fmtError(err) });
        }
      }

      if (crawlMetadata?.summary) {
        try {
          await storeStorySummary(env, {
            storyId: body.storyId,
            sourceUrl: body.url ?? null,
            summary: crawlMetadata.summary,
            updatedAt: now
          });
          log.info({ event: "summary_store_ok", storyId, chars: crawlMetadata.summary.length, source: "crawl" });
        } catch (err) {
          log.warn({ event: "summary_store_fail", storyId, ...log.fmtError(err) });
        }
      }

      const template = mediaTemplateWithFallback(
        await getRandomActivePromptTemplate(env, { modality: "image" }),
        "image"
      );
      const imagePrompt = generatePrompt(template, { title, extractedText });
      const generationStart = Date.now();
      const result = await generateImageWithProvider(env, {
        provider: template.provider,
        model: template.model,
        settings: template.settings,
        prompt: imagePrompt,
        storyId,
        allowPlaceholder: true
      });
      const generationDurationMs = Date.now() - generationStart;
      let mediaKey = null;
      let mediaUrl = result.url;

      if (result.url && env.MEDIA_BUCKET?.put) {
        const imageResponse = await fetch(result.url);
        if (imageResponse.ok) {
          mediaKey = `stories/${body.storyId}-${contentHash}.webp`;
          await env.MEDIA_BUCKET.put(mediaKey, imageResponse.body, {
            httpMetadata: {
              contentType: imageResponse.headers.get("content-type") ?? "image/webp"
            }
          });
          mediaUrl = publicMediaUrlFor(env, mediaKey);
          log.info({ event: "r2_upload_ok", storyId, mediaKey });
        } else {
          log.warn({ event: "r2_fetch_fail", storyId, httpStatus: imageResponse.status });
        }
      }

      await upsertMedia(env, {
        storyId: body.storyId,
        status: result.status,
        falRequestId: result.requestId,
        mediaKey,
        mediaUrl,
        failureReason: result.errorText ?? null,
        attempts: attempt + 1,
        updatedAt: now,
        promptTemplateId: template?.id ?? null,
        imagePrompt,
        mediaType: "image",
        provider: result.provider ?? template.provider ?? "fal",
        model: result.model ?? template.model ?? null,
        generationLatencyMs: generationDurationMs
      });

      await createPromptRunEvent(env, {
        source: "media_pipeline",
        promptKind: "media",
        promptKey: template?.name ?? "image_default",
        promptTemplateId: template?.id ?? null,
        provider: result.provider ?? template.provider ?? "fal",
        model: result.model ?? template.model ?? null,
        modality: "image",
        status: result.status === "ready" ? "ready" : "failed",
        latencyMs: generationDurationMs,
        requestExcerpt: imagePrompt.slice(0, 500),
        responseExcerpt: result.url ?? null,
        artifactUrl: result.url ?? null,
        errorText: result.errorText ?? null,
        storyId: body.storyId
      });

      await updatePublishedFeedEntryMediaProjection(env, body.storyId, {
        mediaType: "image",
        mediaProvider: result.provider ?? template.provider ?? "fal",
        mediaModel: result.model ?? template.model ?? null,
        generationStatus: result.status,
        generationLatencyMs: generationDurationMs,
        generationCostUsd: null,
        promptTemplateId: template?.id ?? null,
        promptTemplateName: template?.name ?? null
      });

      const readyForPublication =
        result.status === "ready" &&
        Boolean(mediaUrl) &&
        (!env.MEDIA_BUCKET?.put || Boolean(mediaKey));

      if (readyForPublication) {
        const publication = await publishReadyStoryViaCoordinator(env, {
          storyId: body.storyId,
          sourceEndpoint: body.endpoint,
          mediaStatus: "ready",
          mediaUrl,
          readableUrl: readableUrlFor(env, body.storyId),
          headline,
          publishedAt: now
        });
        log.info({
          event: "visual_feed_publish_result",
          storyId,
          published: publication.published,
          publishSequence: publication.publishSequence ?? null
        });

        if (publication.published) {
          shaped.upsertItem(env, {
            storyId: body.storyId,
            headline,
            sourceEndpoint: body.endpoint,
            publishedAt: now,
            mediaType: "image",
            mediaProvider: result.provider ?? template.provider ?? "fal",
            mediaModel: result.model ?? template.model ?? null,
            generationStatus: result.status,
            generationLatencyMs: generationDurationMs,
            promptTemplateId: template?.id ?? null,
            promptTemplateName: template?.name ?? null
          }).catch(() => {});
          try {
            await enrichPublishedStory(env, body.storyId, { crawlMetadata });
          } catch (enrichErr) {
            log.warn({ event: "enrich_after_publish_fail", storyId, ...log.fmtError(enrichErr) });
          }
        }
      } else {
        log.debug({
          event: "visual_feed_publish_skip",
          storyId,
          status: result.status,
          hasMediaKey: Boolean(mediaKey),
          hasMediaUrl: Boolean(mediaUrl)
        });
      }

      log.info({
        event: "media_msg_ok",
        storyId,
        status: result.status,
        sourceKind,
        template: template?.name ?? "default",
        durationMs: Date.now() - msgStart
      });
      message.ack();
    } catch (err) {
      const nextAttempt = attempt + 1;
      log.error({
        event: "media_msg_fail",
        storyId,
        attempt: nextAttempt,
        maxRetries,
        durationMs: Date.now() - msgStart,
        ...log.fmtError(err)
      });
      message.retry({ delaySeconds: Math.min(30 * Math.pow(2, attempt), 600) });
    }
  }
}
