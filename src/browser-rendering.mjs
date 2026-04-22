import * as log from "./log.mjs";

const MAX_MARKDOWN_LENGTH = 16000;
const CRAWL_POLL_ATTEMPTS = 20;
const CRAWL_AI_POLL_ATTEMPTS = 30;
const CRAWL_POLL_START_DELAY_MS = 5_000;
const CRAWL_POLL_INITIAL_DELAY_MS = 2_000;
const CRAWL_POLL_MAX_DELAY_MS = 10_000;
const CRAWL_AI_POLL_DELAY_MS = 2_000;
const DEFAULT_CRAWL_LIMIT = 1;
const DEFAULT_CRAWL_DEPTH = 1;
const DEFAULT_CRAWL_PURPOSES = ["ai-input"];
const KEEP_READING_MARKERS = [
  "\nKeep reading...",
  "\nShow less",
  "\nRed"
];
const ARTICLE_METADATA_PROMPT = [
  "Extract structured article data from the crawled page.",
  "Do NOT return the article title — the title is taken verbatim from the source and must not be rewritten here.",
  "Return:",
  "1. A single headline of 60 to 85 characters (hard max 90). One sentence, no trailing period, no emojis, no quotes, no clickbait. It must be a complete thought that fits on a card without truncation.",
  "2. The detected article language as a short ISO-639-1 code when possible.",
  "3. A clear AI-generated summary in the same language as the article.",
  "4. A list of relevant topics as lowercase keywords (e.g., ai, privacy, security, data_retention)."
].join(" ");
const ARTICLE_METADATA_SCHEMA = Object.freeze({
  name: "article_metadata",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      headline: {
        type: "string",
        description: "One short sentence, 60-85 characters (hard max 90), that summarizes the article so it fits on a feed card without truncation. Not the article's title, no trailing period, no emojis, no quotes."
      },
      language: {
        type: "string",
        description: "Detected article language as a short ISO-639-1 code such as en, tr, or fr"
      },
      summary: {
        type: "string",
        description: "AI-generated summary in the same language as the article"
      },
      topics: {
        type: "array",
        description: "List of relevant topics as lowercase keywords",
        items: { type: "string" }
      }
    },
    required: ["headline", "language", "summary", "topics"]
  }
});

function normalizeEnvString(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function classifyHttpFailure(httpStatus, errorText) {
  if (httpStatus === 404) return "permanent";
  if (httpStatus >= 400 && httpStatus < 500) return "http_error";
  if (httpStatus >= 500) return "http_error";
  const lower = typeof errorText === "string" ? errorText.toLowerCase() : "";
  if (lower.includes("robots.txt") || lower.includes("disallowed")) return "robots_blocked";
  return "no_content";
}

function classifyErrorFailureKind(err) {
  if (err && err.failureKind) return err.failureKind;
  const msg = err instanceof Error ? err.message : String(err ?? "");
  if (/timeout/i.test(msg)) return "timeout";
  if (/missing.*config/i.test(msg)) return "config_error";
  return "unknown";
}

function buildCloudflareApiUrl(accountId, path, searchParams = null) {
  const url = new URL(`https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/${path}`);
  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url.toString();
}

function buildCloudflareHeaders(apiToken) {
  return {
    authorization: `Bearer ${apiToken}`,
    "content-type": "application/json"
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getCloudflareCrawlConfig(env) {
  const accountId = normalizeEnvString(env?.CLOUDFLARE_ACCOUNT_ID);
  const apiToken = normalizeEnvString(env?.CLOUDFLARE_API_TOKEN);
  const missing = [];

  if (!accountId) {
    missing.push("CLOUDFLARE_ACCOUNT_ID");
  }
  if (!apiToken) {
    missing.push("CLOUDFLARE_API_TOKEN");
  }

  if (missing.length > 0) {
    const err = new Error(`Missing Cloudflare crawl configuration: ${missing.join(", ")}`);
    err.failureKind = "config_error";
    throw err;
  }

  return { accountId, apiToken };
}

function normalizeCrawlLimit(value) {
  const numeric = Math.floor(Number(value));
  return Number.isFinite(numeric) && numeric >= 1 ? numeric : DEFAULT_CRAWL_LIMIT;
}

function normalizeCrawlDepth(value) {
  const numeric = Math.floor(Number(value));
  return Number.isFinite(numeric) && numeric >= 1 ? numeric : DEFAULT_CRAWL_DEPTH;
}

export function buildArticleMetadataJsonOptions() {
  return {
    prompt: ARTICLE_METADATA_PROMPT,
    response_format: {
      type: "json_schema",
      json_schema: ARTICLE_METADATA_SCHEMA
    }
  };
}

function sanitizeMetadataString(value, maxLength) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.slice(0, maxLength);
}

function normalizeMetadataLanguage(value) {
  const normalized = sanitizeMetadataString(value, 16);
  if (!normalized) {
    return null;
  }

  return normalized.toLowerCase();
}

export function normalizeArticleMetadata(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const rawTopics = Array.isArray(value.topics) ? value.topics : [];
  const topics = rawTopics
    .filter((t) => typeof t === "string" && t.trim())
    .map((t) => t.trim().toLowerCase().slice(0, 100));

  // title: accepted only when it comes from parsed HTML metadata (Firecrawl
  // ogTitle / <title>). The AI extraction schema intentionally omits title
  // because the article's title must never be AI-rewritten.
  const metadata = {
    title: sanitizeMetadataString(value.title, 500),
    headline: sanitizeMetadataString(value.headline, 500),
    language: normalizeMetadataLanguage(value.language),
    summary: sanitizeMetadataString(value.summary, 4000),
    topics: topics.length > 0 ? topics : null
  };

  if (!metadata.title && !metadata.headline && !metadata.language && !metadata.summary) {
    return null;
  }

  return metadata;
}

export function buildCrawlRequest(url, options = {}) {
  const hasExplicitJsonOptions = Object.prototype.hasOwnProperty.call(options, "jsonOptions");
  const jsonOptions = hasExplicitJsonOptions ? options.jsonOptions : buildArticleMetadataJsonOptions();
  const limit = options.limit ?? DEFAULT_CRAWL_LIMIT;
  const depth = options.depth ?? DEFAULT_CRAWL_DEPTH;
  const request = {
    url,
    limit: normalizeCrawlLimit(limit),
    depth: normalizeCrawlDepth(depth),
    crawlPurposes: DEFAULT_CRAWL_PURPOSES,
    formats: jsonOptions ? ["json", "markdown"] : ["markdown"],
  };
  if (jsonOptions) {
    request.jsonOptions = jsonOptions;
  }
  return request;
}

export function readCrawlMarkdown(result, sourceUrl) {
  const records = Array.isArray(result?.records) ? result.records : [];
  const matchingRecord =
    records.find((record) => record?.url === sourceUrl) ??
    records.find((record) => typeof record?.markdown === "string" && record.markdown.trim()) ??
    records[0] ??
    null;

  if (!matchingRecord) {
    return { markdown: null, error: "No crawl records returned" };
  }

  const markdown = typeof matchingRecord.markdown === "string"
    ? extractPrimaryArticleMarkdown(matchingRecord).trim()
    : "";

  if (markdown) {
    const trimmedMarkdown = markdown.slice(0, MAX_MARKDOWN_LENGTH);
    return {
      markdown: trimmedMarkdown,
      error: null,
      truncated: trimmedMarkdown.length < markdown.length
    };
  }

  const httpStatus = matchingRecord?.metadata?.status;
  if (httpStatus) {
    return { markdown: null, error: `HTTP ${httpStatus}: No markdown returned` };
  }

  if (matchingRecord?.status) {
    return { markdown: null, error: `Crawl record status: ${matchingRecord.status}` };
  }

  return { markdown: null, error: "No markdown in crawl response", truncated: false };
}

export function readCrawlJson(result, sourceUrl) {
  const records = Array.isArray(result?.records) ? result.records : [];
  const matchingRecord =
    records.find((record) => record?.url === sourceUrl) ??
    records.find((record) => record?.json != null) ??
    records[0] ??
    null;

  if (!matchingRecord) {
    return { json: null, error: "No crawl records returned" };
  }

  const json = matchingRecord.json;
  if (json != null && typeof json === "object") {
    return { json, error: null };
  }

  const httpStatus = matchingRecord?.metadata?.status;
  if (httpStatus) {
    return { json: null, error: `HTTP ${httpStatus}: No JSON returned` };
  }

  return { json: null, error: "No JSON in crawl response" };
}

function normalizeComparableText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/&[a-z]+;/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function extractTitleCandidate(metadataTitle = "") {
  const title = String(metadataTitle ?? "").trim();
  if (!title) {
    return "";
  }

  return title
    .split(/\s[|\-–—:]\s/)
    .map((part) => part.trim())
    .find((part) => part.length >= 12) ?? title;
}

function stripTrailingBoilerplate(markdown) {
  let trimmed = markdown;
  for (const marker of KEEP_READING_MARKERS) {
    const index = trimmed.indexOf(marker);
    if (index > 0) {
      trimmed = trimmed.slice(0, index).trimEnd();
    }
  }
  return trimmed;
}

function findArticleStartIndex(markdown, metadataTitle = "") {
  const h1Matches = [...markdown.matchAll(/^#\s+(.+)$/gm)];
  if (h1Matches.length === 0) {
    return 0;
  }

  const titleCandidate = extractTitleCandidate(metadataTitle);
  const normalizedTitle = normalizeComparableText(titleCandidate);

  if (normalizedTitle) {
    for (const match of h1Matches) {
      const heading = match[1] ?? "";
      const normalizedHeading = normalizeComparableText(heading);
      if (
        normalizedHeading &&
        (normalizedHeading.includes(normalizedTitle) || normalizedTitle.includes(normalizedHeading))
      ) {
        return match.index ?? 0;
      }
    }
  }

  const delayedH1 = h1Matches.find((match) => (match.index ?? 0) > 500);
  return delayedH1?.index ?? (h1Matches[0].index ?? 0);
}

function extractPrimaryArticleMarkdown(record) {
  const rawMarkdown = typeof record?.markdown === "string" ? record.markdown.trim() : "";
  if (!rawMarkdown) {
    return "";
  }

  const startIndex = findArticleStartIndex(rawMarkdown, record?.metadata?.title);
  return stripTrailingBoilerplate(rawMarkdown.slice(startIndex));
}

async function hashText(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function archiveRawCrawlResult(env, { result, storyId = null, url, jobId }) {
  if (!env.MEDIA_BUCKET?.put) {
    return null;
  }

  const payload = JSON.stringify({
    jobId,
    storyId,
    url,
    result
  });
  const hash = await hashText(`${storyId ?? "none"}:${jobId}:${url}`);
  const storyPart = Number.isInteger(Number(storyId)) && Number(storyId) > 0 ? String(Number(storyId)) : "adhoc";
  const key = `crawl/raw/${storyPart}/${hash}.json`;

  await env.MEDIA_BUCKET.put(key, payload, {
    httpMetadata: {
      contentType: "application/json"
    }
  });

  return key;
}

async function parseCloudflareResponse(response) {
  const data = await response.json().catch(() => null);
  if (response.ok && data?.success) {
    return data;
  }

  const detail = data?.errors?.[0]?.message
    ?? data?.messages?.[0]?.message
    ?? JSON.stringify(data ?? {});
  throw new Error(`Cloudflare crawl API error (${response.status}): ${detail}`);
}

async function createCrawlJob(accountId, apiToken, url, options = {}) {
  const response = await fetch(buildCloudflareApiUrl(accountId, "crawl"), {
    method: "POST",
    headers: buildCloudflareHeaders(apiToken),
    body: JSON.stringify(buildCrawlRequest(url, options))
  });
  const data = await parseCloudflareResponse(response);

  if (typeof data.result !== "string" || !data.result) {
    throw new Error("Cloudflare crawl API did not return a job id");
  }

  return data.result;
}

async function fetchCrawlJob(accountId, apiToken, jobId, searchParams = null) {
  const response = await fetch(buildCloudflareApiUrl(accountId, `crawl/${jobId}`, searchParams), {
    headers: {
      authorization: `Bearer ${apiToken}`
    }
  });
  const data = await parseCloudflareResponse(response);
  return data.result ?? null;
}

async function waitForCrawlJob(accountId, apiToken, jobId, { maxAttempts = CRAWL_POLL_ATTEMPTS, startDelayMs = CRAWL_POLL_START_DELAY_MS, initialDelayMs = CRAWL_POLL_INITIAL_DELAY_MS, maxDelayMs = CRAWL_POLL_MAX_DELAY_MS } = {}) {
  await sleep(startDelayMs);
  let delayMs = initialDelayMs;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const result = await fetchCrawlJob(accountId, apiToken, jobId, { limit: 1 });
    if (result?.status !== "running") {
      return result;
    }
    await sleep(delayMs);
    delayMs = Math.min(delayMs * 2, maxDelayMs);
  }

  const err = new Error("Cloudflare crawl job did not complete within timeout");
  err.failureKind = "timeout";
  throw err;
}

export async function crawlUrlWithAI(env, url, { storyId = null, limit = DEFAULT_CRAWL_LIMIT, prompt, responseSchema } = {}) {
  log.info({ event: "crawl_ai_start", url });

  try {
    const { accountId, apiToken } = getCloudflareCrawlConfig(env);
    const jsonOptions = {
      prompt,
      response_format: {
        type: "json_schema",
        json_schema: responseSchema
      }
    };
    const requestBody = buildCrawlRequest(url, { limit, jsonOptions });
    const response = await fetch(buildCloudflareApiUrl(accountId, "crawl"), {
      method: "POST",
      headers: buildCloudflareHeaders(apiToken),
      body: JSON.stringify(requestBody)
    });
    const data = await parseCloudflareResponse(response);

    if (typeof data.result !== "string" || !data.result) {
      throw new Error("Cloudflare crawl API did not return a job id");
    }

    const jobId = data.result;
    log.info({ event: "crawl_ai_job_created", url, jobId });

    let result = await waitForCrawlJob(accountId, apiToken, jobId, {
      maxAttempts: CRAWL_AI_POLL_ATTEMPTS,
      initialDelayMs: CRAWL_AI_POLL_DELAY_MS,
      maxDelayMs: CRAWL_POLL_MAX_DELAY_MS
    });
    log.info({ event: "crawl_ai_job_polled", url, jobId, status: result?.status ?? "unknown" });

    if (result?.status !== "completed") {
      const errMsg = `Cloudflare crawl job ended with status: ${result?.status ?? "unknown"}`;
      log.warn({ event: "crawl_ai_job_not_completed", url, jobId, status: result?.status ?? "unknown" });
      return { json: null, markdown: null, success: false, error: errMsg, failureKind: "timeout" };
    }

    if (!Array.isArray(result?.records) || result.records.length === 0) {
      log.info({ event: "crawl_ai_fetching_records", url, jobId, reason: "no records in poll response" });
      result = await fetchCrawlJob(accountId, apiToken, jobId, {
        status: "completed",
        limit: 1
      });
    }

    const { json, error: jsonError } = readCrawlJson(result, url);
    const { markdown } = readCrawlMarkdown(result, url);

    if (!json) {
      log.warn({ event: "crawl_ai_no_json", url, jobId, error: jsonError });
      return { json: null, markdown, success: false, error: jsonError, failureKind: "no_content" };
    }

    log.info({ event: "crawl_ai_success", url, jobId });
    return { json, markdown, success: true, error: null, failureKind: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const failureKind = classifyErrorFailureKind(err);
    log.error({ event: "crawl_ai_error", url, error: message, failureKind });
    return { json: null, markdown: null, success: false, error: message, failureKind };
  }
}

export async function submitCrawlJob(env, url) {
  try {
    const { accountId, apiToken } = getCloudflareCrawlConfig(env);
    const jobId = await createCrawlJob(accountId, apiToken, url);
    log.info({ event: "crawl_job_submitted", url, jobId });
    return { jobId, success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ event: "crawl_job_submit_error", url, error: message });
    return { jobId: null, success: false, error: message };
  }
}

export async function checkCrawlJobStatus(env, jobId) {
  try {
    const { accountId, apiToken } = getCloudflareCrawlConfig(env);
    let result = await fetchCrawlJob(accountId, apiToken, jobId, { limit: 1 });

    if (result?.status === "running") {
      return { status: "running" };
    }

    if (result?.status !== "completed") {
      return { status: "failed", error: `Crawl job ended with status: ${result?.status ?? "unknown"}`, failureKind: "timeout" };
    }

    if (!Array.isArray(result?.records) || result.records.length === 0) {
      result = await fetchCrawlJob(accountId, apiToken, jobId, { status: "completed", limit: 1 });
    }

    const { markdown } = readCrawlMarkdown(result, null);
    const { json } = readCrawlJson(result, null);
    const metadata = normalizeArticleMetadata(json);

    return { status: "completed", markdown: markdown ?? null, metadata: metadata ?? null, failureKind: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const failureKind = classifyErrorFailureKind(err);
    log.error({ event: "crawl_job_status_error", jobId, error: message, failureKind });
    return { status: "failed", error: message, failureKind };
  }
}

export async function crawlUrl(env, url, { storyId = null, limit = DEFAULT_CRAWL_LIMIT } = {}) {
  log.info({ event: "crawl_start", url });

  try {
    const { accountId, apiToken } = getCloudflareCrawlConfig(env);
    const jobId = await createCrawlJob(accountId, apiToken, url, { limit });
    log.info({ event: "crawl_job_created", url, jobId });

    let result = await waitForCrawlJob(accountId, apiToken, jobId);
    log.info({ event: "crawl_job_polled", url, jobId, status: result?.status ?? "unknown" });

    if (result?.status !== "completed") {
      const errMsg = `Cloudflare crawl job ended with status: ${result?.status ?? "unknown"}`;
      log.warn({ event: "crawl_job_not_completed", url, jobId, status: result?.status ?? "unknown" });
      return {
        markdown: null,
        success: false,
        error: errMsg,
        failureKind: "timeout"
      };
    }

    if (!Array.isArray(result?.records) || result.records.length === 0) {
      log.info({ event: "crawl_fetching_records", url, jobId, reason: "no records in poll response" });
      result = await fetchCrawlJob(accountId, apiToken, jobId, {
        status: "completed",
        limit: 1
      });
      log.info({ event: "crawl_records_fetched", url, jobId, recordCount: Array.isArray(result?.records) ? result.records.length : 0 });
    }

    const { markdown, error, truncated } = readCrawlMarkdown(result, url);
    if (!markdown) {
      const records = Array.isArray(result?.records) ? result.records : [];
      const httpStatus = records[0]?.metadata?.status ?? null;
      log.warn({
        event: "crawl_no_markdown",
        url,
        jobId,
        error,
        recordCount: records.length,
        records: records.map((r) => ({
          url: r?.url ?? null,
          status: r?.status ?? null,
          httpStatus: r?.metadata?.status ?? null,
          markdownLength: typeof r?.markdown === "string" ? r.markdown.length : 0
        }))
      });
      return { markdown: null, success: false, error, failureKind: classifyHttpFailure(httpStatus, error) };
    }

    const { json, error: jsonError } = readCrawlJson(result, url);
    const metadata = normalizeArticleMetadata(json);
    if (json && !metadata) {
      log.warn({
        event: "crawl_metadata_invalid",
        url,
        jobId,
        detail: JSON.stringify(json).slice(0, 300)
      });
    } else if (jsonError) {
      log.info({ event: "crawl_metadata_missing", url, jobId, error: jsonError });
    }

    let rawJsonKey = null;
    if (truncated) {
      try {
        rawJsonKey = await archiveRawCrawlResult(env, { result, storyId, url, jobId });
        if (rawJsonKey) {
          log.info({ event: "crawl_raw_archived", url, jobId, storyId, rawJsonKey });
        }
      } catch (archiveError) {
        log.warn({
          event: "crawl_raw_archive_failed",
          url,
          jobId,
          storyId,
          error: archiveError instanceof Error ? archiveError.message : String(archiveError)
        });
      }
    }

    log.info({
      event: "crawl_success",
      url,
      jobId,
      markdownLength: markdown.length,
      markdown,
      metadata,
      truncated: Boolean(truncated),
      rawJsonKey: rawJsonKey ?? null
    });
    return { markdown, metadata, success: true, rawJsonKey, failureKind: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const failureKind = classifyErrorFailureKind(err);
    log.error({ event: "crawl_error", url, error: message, failureKind });
    return { markdown: null, success: false, error: message, failureKind };
  }
}
