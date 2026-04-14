import { crawlUrl, crawlUrlWithAI, submitCrawlJob, checkCrawlJobStatus } from "./browser-rendering.mjs";
import { isFirecrawlConfigured, firecrawlScrapeUrl } from "./firecrawl.mjs";
import * as log from "./log.mjs";

// ── Fallback Decision ────────────────────────────────────────────────

const NON_RETRYABLE_KINDS = new Set(["config_error", "permanent"]);

export function shouldFallbackToFirecrawl(cfResult) {
  if (!cfResult) return true;
  if (cfResult.success) return false;
  const kind = cfResult.failureKind ?? "unknown";
  return !NON_RETRYABLE_KINDS.has(kind);
}

// ── Unified Crawl ────────────────────────────────────────────────────

export async function crawlWithFallback(env, url, { storyId = null, recrawl = false, forceFirecrawl = false } = {}) {
  // Force Firecrawl: skip CF entirely
  if (forceFirecrawl) {
    if (!isFirecrawlConfigured(env)) {
      return { markdown: null, metadata: null, success: false, error: "No Firecrawl API keys configured", provider: "firecrawl", failureKind: "config_error", crawlProvider: "firecrawl", cfError: null, cfFailureKind: null };
    }
    log.info({ event: "crawl_force_firecrawl", url, storyId });
    const fcResult = await firecrawlScrapeUrl(env, url, { storyId });
    return { ...fcResult, crawlProvider: "firecrawl", cfError: null, cfFailureKind: null };
  }

  const cfResult = await crawlUrl(env, url, { storyId });

  if (cfResult.success) {
    return { ...cfResult, crawlProvider: "cloudflare", cfError: null, cfFailureKind: null };
  }

  if (!isFirecrawlConfigured(env) || !shouldFallbackToFirecrawl(cfResult)) {
    log.info({
      event: "crawl_no_fallback",
      url,
      storyId,
      cfFailureKind: cfResult.failureKind,
      firecrawlConfigured: isFirecrawlConfigured(env)
    });
    return { ...cfResult, crawlProvider: "cloudflare", cfError: cfResult.error ?? null, cfFailureKind: cfResult.failureKind ?? null };
  }

  log.info({
    event: "crawl_fallback_triggered",
    url,
    storyId,
    cfError: cfResult.error,
    cfFailureKind: cfResult.failureKind,
    provider: "firecrawl"
  });

  const fcResult = await firecrawlScrapeUrl(env, url, { storyId });

  if (fcResult.success) {
    log.info({ event: "crawl_fallback_success", url, storyId, provider: "firecrawl" });
    return { ...fcResult, crawlProvider: "firecrawl", cfError: cfResult.error ?? null, cfFailureKind: cfResult.failureKind ?? null };
  }

  log.warn({
    event: "crawl_all_providers_failed",
    url,
    storyId,
    cfError: cfResult.error,
    fcError: fcResult.error
  });
  return { ...cfResult, crawlProvider: "cloudflare", cfError: cfResult.error ?? null, cfFailureKind: cfResult.failureKind ?? null };
}

// ── Unified AI Crawl ─────────────────────────────────────────────────

export async function crawlWithFallbackAI(env, url, { storyId = null, limit, prompt, responseSchema } = {}) {
  const cfResult = await crawlUrlWithAI(env, url, { storyId, limit, prompt, responseSchema });

  if (cfResult.success) {
    return { ...cfResult, crawlProvider: "cloudflare" };
  }

  if (!isFirecrawlConfigured(env) || !shouldFallbackToFirecrawl(cfResult)) {
    return { ...cfResult, crawlProvider: "cloudflare" };
  }

  log.info({
    event: "crawl_ai_fallback_triggered",
    url,
    storyId,
    cfError: cfResult.error,
    cfFailureKind: cfResult.failureKind,
    provider: "firecrawl"
  });

  // Firecrawl doesn't support custom AI schemas, so scrape markdown only.
  // The caller (ai-gateway.mjs) will handle AI extraction on the markdown.
  const fcResult = await firecrawlScrapeUrl(env, url, { storyId });

  if (fcResult.success) {
    log.info({ event: "crawl_ai_fallback_success", url, storyId, provider: "firecrawl" });
    return {
      json: null,
      markdown: fcResult.markdown,
      metadata: fcResult.metadata,
      success: true,
      error: null,
      failureKind: null,
      crawlProvider: "firecrawl",
      needsAIExtraction: true
    };
  }

  log.warn({
    event: "crawl_ai_all_providers_failed",
    url,
    storyId,
    cfError: cfResult.error,
    fcError: fcResult.error
  });
  return { ...cfResult, crawlProvider: "cloudflare" };
}

// ── Async Job Wrappers ───────────────────────────────────────────────

export async function submitCrawlJobWithTracking(env, url) {
  return submitCrawlJob(env, url);
}

export async function checkCrawlJobWithFallback(env, jobId, url, { storyId = null } = {}) {
  const cfResult = await checkCrawlJobStatus(env, jobId);

  if (cfResult.status === "running") {
    return cfResult;
  }

  if (cfResult.status === "completed") {
    return { ...cfResult, crawlProvider: "cloudflare" };
  }

  // Job failed — try Firecrawl fallback
  if (!url || !isFirecrawlConfigured(env) || !shouldFallbackToFirecrawl(cfResult)) {
    return { ...cfResult, crawlProvider: "cloudflare" };
  }

  log.info({
    event: "crawl_job_fallback_triggered",
    jobId,
    url,
    storyId,
    cfError: cfResult.error,
    cfFailureKind: cfResult.failureKind,
    provider: "firecrawl"
  });

  const fcResult = await firecrawlScrapeUrl(env, url, { storyId });

  if (fcResult.success) {
    log.info({ event: "crawl_job_fallback_success", jobId, url, storyId, provider: "firecrawl" });
    return {
      status: "completed",
      markdown: fcResult.markdown,
      metadata: fcResult.metadata,
      failureKind: null,
      crawlProvider: "firecrawl"
    };
  }

  return { ...cfResult, crawlProvider: "cloudflare" };
}
