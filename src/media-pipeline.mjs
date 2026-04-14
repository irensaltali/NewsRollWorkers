import {
  storeStory,
  storeHeadline,
  storeStorySummary,
  createPromptRunEvent,
  upsertMedia,
  updatePublishedFeedEntryMediaProjection,
  getRandomActivePromptTemplate,
  reserveMediaQueueSlot,
  releaseMediaQueueSlot,
  getRSSSourceIdByStoryId,
  setRSSSourceActive,
  storeReadableContent,
  markRSSItemCrawlFailure,
  clearRSSItemCrawlFailure
} from "./db.mjs";
import {
  publicMediaUrlFor,
  MEDIA_MAX_QUEUE_RETRIES,
  MEDIA_DAILY_LIMIT_DEFAULT,
  MEDIA_PER_RUN_LIMIT_DEFAULT,
  MEDIA_MIN_SCORE_DEFAULT,
  MEDIA_FALAI_DAILY_LIMIT_DEFAULT
} from "./config.mjs";
import { resolveArticleContent } from "./article-content.mjs";
import { publishReadyStoryViaCoordinator } from "./global-visual-feed-coordinator.mjs";
import { ingestCategory } from "./rss-ingest.mjs";
import * as log from "./log.mjs";
import * as shaped from "./shaped.mjs";
import { readableUrlFor } from "./visual-feed.mjs";
import { buildFalImageRequest, generateImageWithProvider } from "./media-generation.mjs";
import { buildPromptInput, clipPromptText, mediaTemplateWithFallback } from "./prompt-config.mjs";
import { crawlWithFallback, submitCrawlJobWithTracking, checkCrawlJobWithFallback } from "./crawl-provider.mjs";

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

export function falAiDailyLimit(env) {
  const parsed = Number.parseInt(env?.MEDIA_FALAI_LIMIT ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : MEDIA_FALAI_DAILY_LIMIT_DEFAULT;
}

const FAL_DAILY_KV_PREFIX = "fal:daily:";

function todayUtcDate() {
  return new Date().toISOString().slice(0, 10);
}

async function getDailyFalCount(env) {
  if (!env?.VISUAL_FEED_CACHE?.get) return 0;
  const value = await env.VISUAL_FEED_CACHE.get(`${FAL_DAILY_KV_PREFIX}${todayUtcDate()}`);
  const parsed = Number.parseInt(value ?? "0", 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function incrementDailyFalCount(env) {
  if (!env?.VISUAL_FEED_CACHE?.put) return;
  const key = `${FAL_DAILY_KV_PREFIX}${todayUtcDate()}`;
  const current = await getDailyFalCount(env);
  await env.VISUAL_FEED_CACHE.put(key, String(current + 1), { expirationTtl: 90000 });
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
    let crawlJobId = null;
    let sendOptions = undefined;

    if (story.url) {
      const crawlSubmit = await submitCrawlJobWithTracking(env, story.url);
      if (crawlSubmit.success) {
        crawlJobId = crawlSubmit.jobId;
        sendOptions = { delaySeconds: 180 };
        log.debug({ event: "media_enqueue_crawl_submitted", storyId: story.id, crawlJobId });
      } else {
        log.warn({ event: "media_enqueue_crawl_submit_fail", storyId: story.id, error: crawlSubmit.error });
      }
    }

    await env.MEDIA_QUEUE.send({
      storyId: story.id,
      endpoint,
      url: story.url ?? null,
      title: story.title ?? "",
      crawlJobId,
      crawlAttempts: 0
    }, sendOptions);
    log.debug({ event: "media_enqueue_ok", storyId: story.id, endpoint, crawlJobId, delayed: Boolean(sendOptions) });
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

export async function processMediaMessage(batch, env, ctx = null) {
  const maxRetries = maxQueueRetries(env);

  const MAX_CRAWL_WAITS = 5;

  // ── Daily fal limit gate (checked once per batch, before any work) ──────────
  const falLimit = falAiDailyLimit(env);
  let falDailyCount = await getDailyFalCount(env);
  const falLimitReached = falLimit > 0 && falDailyCount >= falLimit;
  if (falLimitReached) {
    log.warn({ event: "fal_daily_limit_reached_batch", dailyCount: falDailyCount, limit: falLimit });
    for (const message of batch.messages) {
      const storyId = message.body?.storyId;
      log.info({ event: "media_msg_skip_fal_limit", storyId, dailyCount: falDailyCount, limit: falLimit });
      await upsertMedia(env, {
        storyId,
        status: "skipped",
        falRequestId: null,
        mediaKey: null,
        mediaUrl: null,
        failureReason: `Fal daily limit reached (${falDailyCount}/${falLimit})`,
        attempts: (message.attempts ?? 0) + 1,
        updatedAt: new Date().toISOString(),
        promptTemplateId: null,
        imagePrompt: null
      });
      message.ack();
    }
    return;
  }

  for (const message of batch.messages) {
    const storyId = message.body?.storyId;
    const attempt = message.attempts ?? 0;
    const msgStart = Date.now();
    let crawlJobMetadata = null;
    let metadataFailureReason = null;

    // Crawl-wait gate: if a crawl job was pre-submitted by ingest, check its status first
    if (message.body?.crawlJobId) {
      const crawlJobId = message.body.crawlJobId;
      const crawlAttempts = message.body.crawlAttempts ?? 0;
      const crawlCheck = await checkCrawlJobWithFallback(env, crawlJobId, message.body.url, { storyId });

      if (crawlCheck.status === "running") {
        if (crawlAttempts >= MAX_CRAWL_WAITS) {
          log.error({ event: "media_msg_dead_letter", storyId, reason: "crawl_wait_exhausted", crawlAttempts });
          await upsertMedia(env, {
            storyId,
            status: "dead_letter",
            falRequestId: null,
            mediaKey: null,
            mediaUrl: null,
            failureReason: `Crawl job did not complete after ${MAX_CRAWL_WAITS} waits`,
            attempts: attempt,
            updatedAt: new Date().toISOString(),
            promptTemplateId: null,
            imagePrompt: null
          });
          message.ack();
          continue;
        }
        await env.MEDIA_QUEUE.send(
          { ...message.body, crawlAttempts: crawlAttempts + 1 },
          { delaySeconds: 30 }
        );
        message.ack();
        log.info({ event: "crawl_wait_requeue", storyId, crawlJobId, crawlAttempts: crawlAttempts + 1 });
        continue;
      }

      if (crawlCheck.status === "completed" && crawlCheck.markdown) {
        crawlJobMetadata = crawlCheck.metadata && typeof crawlCheck.metadata === "object"
          ? crawlCheck.metadata
          : null;
        if (!crawlJobMetadata) {
          metadataFailureReason = "no_metadata";
        }
        const numericStoryId = Number(storyId);
        if (Number.isInteger(numericStoryId) && numericStoryId > 0) {
          try {
            await storeReadableContent(env, {
              storyId: numericStoryId,
              sourceKind: "crawl",
              extractedText: crawlCheck.markdown,
              sourceUrl: message.body.url,
              updatedAt: new Date().toISOString()
            });
            log.info({ event: "crawl_job_result_cached", storyId, crawlJobId });
          } catch (cacheErr) {
            log.warn({ event: "crawl_job_cache_fail", storyId, ...log.fmtError(cacheErr) });
          }
        }
      } else if (crawlCheck.status === "failed") {
        metadataFailureReason = crawlCheck.error ?? "crawl_job_failed";
        log.warn({ event: "crawl_job_failed", storyId, crawlJobId, error: crawlCheck.error ?? "unknown" });
      }
    }

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
      // If a crawl job was pre-submitted, the result is already cached or failed — skip sync crawl
      const hasCrawlJob = Boolean(body.crawlJobId);
      let resolvedArticle = await resolveArticleContent(env, storyId, {
        title: body.title ?? "",
        url: body.url ?? null
      }, {
        allowCrawl: false
      });

      if (!hasCrawlJob && needsMediaCrawl(body, resolvedArticle)) {
        resolvedArticle = await resolveArticleContent(env, storyId, {
          title: body.title ?? "",
          url: body.url ?? null
        });
      }

      if (resolvedArticle.crawlError) {
        const isPermanent = /robots\.txt|disallowed|4\d\d/i.test(resolvedArticle.crawlError);
        if (isPermanent) {
          log.warn({ event: "crawl_permanent_fail", storyId, url: body.url ?? null, error: resolvedArticle.crawlError });
          await upsertMedia(env, {
            storyId,
            status: "skipped",
            falRequestId: null,
            mediaKey: null,
            mediaUrl: null,
            failureReason: `Crawl blocked: ${resolvedArticle.crawlError}`,
            attempts: attempt + 1,
            updatedAt: new Date().toISOString(),
            promptTemplateId: null,
            imagePrompt: null
          });
          const sourceId = await getRSSSourceIdByStoryId(env, storyId);
          if (sourceId) {
            await setRSSSourceActive(env, sourceId, false);
            log.warn({ event: "rss_source_deactivated", storyId, sourceId, reason: "crawl_blocked" });
          }
          message.ack();
          continue;
        }
      }

      let crawlMetadata =
        (resolvedArticle.metadata && typeof resolvedArticle.metadata === "object"
          ? resolvedArticle.metadata
          : null)
        ?? crawlJobMetadata;

      // If article text came from RSS/cache but metadata was never extracted, crawl for it now
      // Skip if a crawl job was pre-submitted (result already stored or job failed)
      if (!hasCrawlJob && !crawlMetadata && body.url) {
        log.info({ event: "metadata_crawl_start", storyId, url: body.url });
        const metaCrawl = await crawlWithFallback(env, body.url, { storyId });
        if (metaCrawl.success && metaCrawl.metadata) {
          crawlMetadata = metaCrawl.metadata;
          log.info({ event: "metadata_crawl_ok", storyId });
        } else {
          const crawlError = metaCrawl.error ?? "no_metadata";
          metadataFailureReason = crawlError;
          log.warn({ event: "metadata_crawl_fail", storyId, url: body.url, error: crawlError });
          const isPermanent = /robots\.txt|disallowed|4\d\d/i.test(crawlError);
          if (isPermanent) {
            const sourceId = await getRSSSourceIdByStoryId(env, storyId);
            if (sourceId) {
              await setRSSSourceActive(env, sourceId, false);
              log.warn({ event: "rss_source_deactivated", storyId, sourceId, reason: "metadata_crawl_blocked" });
            }
          }
        }
      }

      if (!crawlMetadata) {
        const crawlError = metadataFailureReason ?? (body.url ? "no_metadata" : "missing_story_url");
        log.warn({ event: "metadata_required_missing", storyId, url: body.url ?? null, error: crawlError });
        try {
          await markRSSItemCrawlFailure(env, storyId, crawlError);
        } catch (err) {
          log.warn({ event: "rss_item_crawl_failure_mark_fail", storyId, error: crawlError, ...log.fmtError(err) });
        }
        await upsertMedia(env, {
          storyId,
          status: "skipped",
          falRequestId: null,
          mediaKey: null,
          mediaUrl: null,
          failureReason: `Missing crawl metadata: ${crawlError}`,
          attempts: attempt + 1,
          updatedAt: new Date().toISOString(),
          promptTemplateId: null,
          imagePrompt: null
        });
        message.ack();
        continue;
      }

      try {
        await clearRSSItemCrawlFailure(env, storyId);
      } catch (err) {
        log.warn({ event: "rss_item_crawl_failure_clear_fail", storyId, ...log.fmtError(err) });
      }

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
      const summary = crawlMetadata?.summary ?? null;
      const topics = Array.isArray(crawlMetadata?.topics) ? crawlMetadata.topics : null;

      if (headline || summary || topics) {
        try {
          await storeHeadline(env, body.storyId, headline);
          if (summary) {
            await storeStorySummary(env, {
              storyId: body.storyId,
              sourceUrl: body.url ?? null,
              summary,
              topics,
              updatedAt: now
            });
          } else if (topics) {
            await storeStorySummary(env, {
              storyId: body.storyId,
              sourceUrl: body.url ?? null,
              topics,
              updatedAt: now
            });
          }
          log.info({
            event: "crawl_metadata_stored",
            storyId,
            hasHeadline: Boolean(headline),
            hasSummary: Boolean(summary),
            topicCount: topics?.length ?? 0,
            source: "crawl"
          });
        } catch (err) {
          log.warn({ event: "crawl_metadata_store_fail", storyId, ...log.fmtError(err) });
        }
      }

      const template = mediaTemplateWithFallback(
        await getRandomActivePromptTemplate(env, { modality: "image" }),
        "image"
      );
      const imagePrompt = generatePrompt(template, { title, extractedText });
      const generationStart = Date.now();

      // Re-check fal limit per message (count may have incremented within this batch)
      falDailyCount = await getDailyFalCount(env);
      if (falLimit > 0 && falDailyCount >= falLimit) {
        log.warn({ event: "fal_daily_limit_reached", storyId, dailyCount: falDailyCount, limit: falLimit });
        await upsertMedia(env, {
          storyId,
          status: "skipped",
          falRequestId: null,
          mediaKey: null,
          mediaUrl: null,
          failureReason: `Fal daily limit reached (${falDailyCount}/${falLimit})`,
          attempts: attempt + 1,
          updatedAt: new Date().toISOString(),
          promptTemplateId: template?.id ?? null,
          imagePrompt
        });
        message.ack();
        continue;
      }

      const result = await generateImageWithProvider(env, {
        provider: template.provider,
        model: template.model,
        settings: template.settings,
        prompt: imagePrompt,
        storyId
      });
      if (result.provider === "fal" && result.status === "ready") {
        await incrementDailyFalCount(env);
      }

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
          const shapedPromise = shaped.upsertItem(env, {
            storyId: body.storyId,
            headline,
            title,
            summary,
            category: body.endpoint,
            topics: topics ?? null,
            publishedAt: now,
            mediaUrl,
            mediaType: "image",
            mediaProvider: result.provider ?? template.provider ?? "fal",
            mediaModel: result.model ?? template.model ?? null,
            promptTemplateId: template?.id ?? null
          });
          if (ctx) {
            ctx.waitUntil(shapedPromise);
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
