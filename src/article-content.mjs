import { getReadableContent, storeReadableContent } from "./db.mjs";
import { crawlWithFallback } from "./crawl-provider.mjs";
import * as log from "./log.mjs";

function now() {
  return new Date().toISOString();
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

export async function resolveArticleUrl(_env, _storyId, { url = null } = {}) {
  const normalizedUrl = typeof url === "string" ? url.trim() : "";
  return normalizedUrl || null;
}

export async function resolveArticleContent(env, storyId, { title = "", text = "", url = null } = {}, { allowCrawl = true, recrawl = false } = {}) {
  const numericStoryId = Number(storyId);
  const hasStoryId = Number.isInteger(numericStoryId) && numericStoryId > 0;
  const normalizedTitle = normalizeText(title);
  const normalizedText = normalizeText(text);
  const normalizedUrl = typeof url === "string" ? url.trim() : "";

  log.info({ event: "resolve_article_start", storyId: numericStoryId, hasStoryId, hasText: !!normalizedText, hasUrl: !!normalizedUrl });

  // Step 1: Check cached readable content (skip when recrawl is forced)
  if (hasStoryId && !recrawl) {
    const readableContent = await getReadableContent(env, numericStoryId);
    const cachedText = normalizeText(readableContent?.extractedText);
    if (cachedText) {
      log.info({ event: "resolve_article_hit", storyId: numericStoryId, sourceKind: "cache", textLength: cachedText.length, hasAiHeadline: Boolean(readableContent.aiHeadline) });
      return {
        title: normalizedTitle,
        text: cachedText,
        url: normalizedUrl,
        sourceKind: "cache",
        metadata: null,
        aiHeadline: readableContent.aiHeadline
      };
    }
    log.info({ event: "resolve_article_cache_miss", storyId: numericStoryId });
  }

  // Step 2: Use client-provided text
  if (normalizedText) {
    log.info({ event: "resolve_article_hit", storyId: numericStoryId, sourceKind: "provided", textLength: normalizedText.length });
    return {
      title: normalizedTitle,
      text: normalizedText,
      url: normalizedUrl,
      sourceKind: "provided",
      metadata: null
    };
  }

  // Step 3: Crawl the URL
  const resolvedUrl = normalizedUrl;
  if (resolvedUrl && allowCrawl) {
    log.info({ event: "resolve_article_crawl_start", storyId: numericStoryId, url: resolvedUrl });
    const crawlResult = await crawlWithFallback(env, resolvedUrl, { storyId: numericStoryId, recrawl });
    const crawledText = normalizeText(crawlResult.markdown);
    if (crawlResult.success && crawledText) {
      if (hasStoryId) {
        await storeReadableContent(env, {
          storyId: numericStoryId,
          sourceKind: "crawl",
          extractedText: crawledText,
          sourceUrl: resolvedUrl,
          updatedAt: now()
        });
      }
      log.info({ event: "resolve_article_hit", storyId: numericStoryId, sourceKind: "crawl", textLength: crawledText.length });
      return {
        title: crawlResult.metadata?.title || normalizedTitle,
        text: crawledText,
        url: resolvedUrl,
        sourceKind: "crawl",
        metadata: crawlResult.metadata ?? null
      };
    }
    log.warn({
      event: "resolve_article_crawl_failed",
      storyId: numericStoryId,
      url: resolvedUrl,
      error: crawlResult.error ?? "unknown",
      rawJsonKey: crawlResult.rawJsonKey ?? null
    });
    log.warn({ event: "resolve_article_empty", storyId: numericStoryId, url: normalizedUrl || null });
    return {
      title: normalizedTitle,
      text: "",
      url: normalizedUrl,
      sourceKind: null,
      metadata: null,
      crawlError: crawlResult.error ?? "unknown"
    };
  }

  log.warn({ event: "resolve_article_empty", storyId: numericStoryId, url: normalizedUrl || null });
  return {
    title: normalizedTitle,
    text: "",
    url: normalizedUrl,
    sourceKind: null,
    metadata: null
  };
}
