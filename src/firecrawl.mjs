import { normalizeArticleMetadata } from "./browser-rendering.mjs";
import * as log from "./log.mjs";

const FIRECRAWL_API_BASE = "https://api.firecrawl.dev/v1";
const MAX_MARKDOWN_LENGTH = 16000;
const KV_RR_INDEX_KEY = "firecrawl:rr:index";
const KV_TTL_SECONDS = 90000; // 25 hours

// ── Key Parsing ──────────────────────────────────────────────────────

export function parseFirecrawlApiKeys(env) {
  const raw = typeof env?.FIRECRAWL_API_KEYS === "string" ? env.FIRECRAWL_API_KEYS : "";
  return raw
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}

export function isFirecrawlConfigured(env) {
  return parseFirecrawlApiKeys(env).length > 0;
}

// ── Round-Robin Key Selection ────────────────────────────────────────

async function getKvValue(env, key) {
  if (!env?.VISUAL_FEED_CACHE?.get) return null;
  return env.VISUAL_FEED_CACHE.get(key);
}

async function setKvValue(env, key, value) {
  if (!env?.VISUAL_FEED_CACHE?.put) return;
  await env.VISUAL_FEED_CACHE.put(key, String(value), { expirationTtl: KV_TTL_SECONDS });
}

export async function selectNextKey(env, keys) {
  if (!keys || keys.length === 0) return null;

  const value = await getKvValue(env, KV_RR_INDEX_KEY);
  const currentIndex = Number.parseInt(value ?? "0", 10) || 0;
  const keyIndex = currentIndex % keys.length;
  const nextIndex = (keyIndex + 1) % keys.length;

  await setKvValue(env, KV_RR_INDEX_KEY, nextIndex);
  log.info({ event: "firecrawl_key_selected", keyIndex, totalKeys: keys.length });
  return { apiKey: keys[keyIndex], keyIndex };
}

// ── Metadata Mapping ─────────────────────────────────────────────────

export function mapFirecrawlMetadata(firecrawlData) {
  const meta = firecrawlData?.rawMetadata ?? firecrawlData?.metadata ?? {};
  const raw = {
    title: meta.ogTitle || meta.title || null,
    headline: meta.ogDescription || meta.description || null,
    language: meta.language || null,
    summary: meta.description || null,
    topics: null
  };
  return normalizeArticleMetadata(raw);
}

// ── API Call ─────────────────────────────────────────────────────────

async function callFirecrawlScrape(apiKey, url) {
  const body = {
    url,
    formats: ["markdown"],
    onlyMainContent: true,
    timeout: 30000
  };

  const response = await fetch(`${FIRECRAWL_API_BASE}/scrape`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    return {
      success: false,
      error: `Firecrawl API error (${response.status}): ${JSON.stringify(data ?? {}).slice(0, 300)}`,
      statusCode: response.status
    };
  }

  if (!data?.success) {
    return {
      success: false,
      error: data?.error ?? "Firecrawl returned success=false",
      statusCode: response.status
    };
  }

  return {
    success: true,
    markdown: data.data?.markdown ?? null,
    rawMetadata: data.data?.metadata ?? null,
    statusCode: response.status
  };
}

// ── Public API ───────────────────────────────────────────────────────

export async function firecrawlScrapeUrl(env, url, { storyId = null } = {}) {
  const keys = parseFirecrawlApiKeys(env);
  if (keys.length === 0) {
    return { markdown: null, metadata: null, success: false, error: "No Firecrawl API keys configured", provider: "firecrawl", failureKind: "config_error" };
  }

  const selected = await selectNextKey(env, keys);
  if (!selected) {
    return { markdown: null, metadata: null, success: false, error: "No Firecrawl key available", provider: "firecrawl", failureKind: "config_error" };
  }

  log.info({ event: "firecrawl_scrape_start", url, storyId, keyIndex: selected.keyIndex });

  try {
    const result = await callFirecrawlScrape(selected.apiKey, url);

    if (!result.success) {
      log.warn({ event: "firecrawl_scrape_fail", url, storyId, keyIndex: selected.keyIndex, error: result.error, statusCode: result.statusCode });
      return { markdown: null, metadata: null, success: false, error: result.error, provider: "firecrawl", failureKind: "http_error" };
    }

    const markdown = typeof result.markdown === "string"
      ? result.markdown.trim().slice(0, MAX_MARKDOWN_LENGTH)
      : null;

    if (!markdown) {
      log.warn({ event: "firecrawl_scrape_no_markdown", url, storyId, keyIndex: selected.keyIndex });
      return { markdown: null, metadata: null, success: false, error: "Firecrawl returned no markdown", provider: "firecrawl", failureKind: "no_content" };
    }

    const metadata = mapFirecrawlMetadata(result);

    log.info({ event: "firecrawl_scrape_ok", url, storyId, keyIndex: selected.keyIndex, markdownLength: markdown.length });
    return { markdown, metadata, success: true, error: null, provider: "firecrawl", failureKind: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ event: "firecrawl_scrape_error", url, storyId, keyIndex: selected.keyIndex, error: message });
    return { markdown: null, metadata: null, success: false, error: message, provider: "firecrawl", failureKind: "unknown" };
  }
}
