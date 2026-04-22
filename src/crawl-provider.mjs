import { crawlUrl, crawlUrlWithAI, submitCrawlJob, checkCrawlJobStatus } from "./browser-rendering.mjs";
import {
  isFirecrawlConfigured,
  firecrawlScrapeUrl,
  submitFirecrawlJob,
  checkFirecrawlJob
} from "./firecrawl.mjs";
import * as log from "./log.mjs";

export const CRAWL_PROVIDERS = Object.freeze({
  CLOUDFLARE: "cloudflare",
  FIRECRAWL: "firecrawl"
});

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

// ── Unified Provider-Agnostic Async API ──────────────────────────────

export async function submitCrawl(env, provider, url) {
  if (provider === CRAWL_PROVIDERS.CLOUDFLARE) {
    return submitCrawlJob(env, url);
  }
  if (provider === CRAWL_PROVIDERS.FIRECRAWL) {
    return submitFirecrawlJob(env, url);
  }
  return { jobId: null, success: false, error: `Unknown crawl provider: ${provider}`, failureKind: "config_error" };
}

// Submit-phase failures never indicate a permanent origin block (we haven't
// crawled yet), so any CF submit error should try Firecrawl when configured.
export async function submitCrawlWithProviderFallback(env, url, { storyId = null } = {}) {
  const cf = await submitCrawl(env, CRAWL_PROVIDERS.CLOUDFLARE, url);
  if (cf.success) {
    return {
      success: true,
      provider: CRAWL_PROVIDERS.CLOUDFLARE,
      jobId: cf.jobId,
      error: null,
      cfError: null
    };
  }

  if (!isFirecrawlConfigured(env)) {
    return {
      success: false,
      provider: CRAWL_PROVIDERS.CLOUDFLARE,
      jobId: null,
      error: cf.error ?? null,
      cfError: cf.error ?? null
    };
  }

  log.info({
    event: "crawl_submit_fallback_triggered",
    url,
    storyId,
    cfError: cf.error,
    provider: CRAWL_PROVIDERS.FIRECRAWL
  });

  const fc = await submitCrawl(env, CRAWL_PROVIDERS.FIRECRAWL, url);
  if (fc.success) {
    log.info({ event: "crawl_submit_fallback_success", url, storyId, provider: CRAWL_PROVIDERS.FIRECRAWL });
    return {
      success: true,
      provider: CRAWL_PROVIDERS.FIRECRAWL,
      jobId: fc.jobId,
      error: null,
      cfError: cf.error ?? null
    };
  }

  log.warn({
    event: "crawl_submit_all_providers_failed",
    url,
    storyId,
    cfError: cf.error,
    fcError: fc.error
  });
  return {
    success: false,
    provider: CRAWL_PROVIDERS.FIRECRAWL,
    jobId: null,
    error: fc.error ?? null,
    cfError: cf.error ?? null
  };
}

export async function checkCrawl(env, provider, jobId) {
  if (provider === CRAWL_PROVIDERS.CLOUDFLARE) {
    return checkCrawlJobStatus(env, jobId);
  }
  if (provider === CRAWL_PROVIDERS.FIRECRAWL) {
    return checkFirecrawlJob(env, jobId);
  }
  return { status: "failed", error: `Unknown crawl provider: ${provider}`, failureKind: "config_error" };
}

// ── Async Job Wrappers (legacy) ──────────────────────────────────────

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
