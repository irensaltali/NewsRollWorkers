import * as log from "./log.mjs";
import {
  storeStory,
  storeReadableContent,
  reserveMediaQueueSlot,
  releaseMediaQueueSlot,
  getRSSSources,
  insertRSSItem,
  markSourceFetched
} from "./db.mjs";

const RSS_MEDIA_QUALITY_THRESHOLD = 0.40;
const RSS_FETCH_TIMEOUT_MS = 10_000;

// ── URL helpers ───────────────────────────────────────────────────────────────

const TRACKING_PARAMS = [
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "ref", "source", "fbclid", "gclid", "mc_cid", "mc_eid"
];

export function canonicalizeUrl(url) {
  try {
    const u = new URL(url);
    for (const p of TRACKING_PARAMS) u.searchParams.delete(p);
    const path = u.pathname.replace(/\/+$/, "") || "/";
    return `${u.protocol}//${u.host.toLowerCase()}${path}${u.search}`;
  } catch {
    return url.toLowerCase().trim();
  }
}

export async function urlToStoryId(url) {
  const canonical = canonicalizeUrl(url);
  const buffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  const view = new DataView(buffer);
  // Offset by 1,000,000,000 to stay safely above the HN story ID range (~43M)
  return (view.getUint32(0) >>> 0) + 1_000_000_000;
}

// ── RSS / Atom parser (no DOMParser in Workers) ───────────────────────────────

function extractCDATA(text) {
  return text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
}

function extractTag(xml, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = xml.match(re);
  return m ? extractCDATA(m[1]).trim() || null : null;
}

function extractAttrTag(xml, tag, attr) {
  const re = new RegExp(`<${tag}[^>]+${attr}=["']([^"']+)["']`, "i");
  const m = xml.match(re);
  return m ? m[1].trim() : null;
}

function decodeEntities(text) {
  return (text ?? "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

export function parseRSS(xml) {
  const items = [];
  const blockRe = /<(item|entry)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi;
  let match;

  while ((match = blockRe.exec(xml)) !== null) {
    const block = match[0];

    // RSS uses text <link>; Atom uses <link href="..."/>
    const linkAttr = extractAttrTag(block, "link", "href");
    const linkText = extractTag(block, "link");
    const url = linkAttr || (linkText?.startsWith("http") ? linkText : null);
    if (!url) continue;

    const guid = extractTag(block, "guid") || extractTag(block, "id") || url;

    // Atom nests author as <author><name>...</name></author>
    const authorBlock = extractTag(block, "author");
    const author = authorBlock
      ? (extractTag(authorBlock, "name") ?? extractCDATA(authorBlock))
      : extractTag(block, "dc:creator");

    items.push({
      guid,
      url,
      title:       decodeEntities(extractTag(block, "title") ?? ""),
      description: decodeEntities(
        extractTag(block, "description") || extractTag(block, "summary") || ""
      ),
      author:      author || null,
      publishedAt:
        extractTag(block, "pubDate") ||
        extractTag(block, "published") ||
        extractTag(block, "updated") ||
        null
    });
  }

  return items;
}

export async function fetchAndParseRSS(feedUrl) {
  const resp = await fetch(feedUrl, {
    signal: AbortSignal.timeout(RSS_FETCH_TIMEOUT_MS),
    headers: { "User-Agent": "NewsRoll/1.0 (+https://newsroll.app)" }
  });
  if (!resp.ok) {
    throw new Error(`RSS fetch failed: HTTP ${resp.status} for ${feedUrl}`);
  }
  const xml = await resp.text();
  return parseRSS(xml);
}

// ── Quality scoring ───────────────────────────────────────────────────────────

export function computeRSSQualityScore(item, source) {
  const publishedAt = item.publishedAt ? new Date(item.publishedAt) : null;
  const hoursAgo = publishedAt
    ? (Date.now() - publishedAt.getTime()) / 3_600_000
    : 24;
  const recency =
    hoursAgo <= 0 ? 1.0 : hoursAgo >= 48 ? 0.1 : 1.0 - (0.9 * hoursAgo) / 48;
  const tierScore = source.tier === 1 ? 1.0 : source.tier === 3 ? 0.33 : 0.67;
  return (
    0.4 * (source.reliability_score ?? 0.5) +
    0.3 * tierScore +
    0.3 * recency
  );
}

function rssMediaDailyLimit(env) {
  const v =
    env.MEDIA_DAILY_LIMIT ??
    (env.ENVIRONMENT === "staging" ? (env.STAGING_MEDIA_DAILY_LIMIT ?? "10") : null);
  if (v === null) return 50;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : 50;
}

// ── Core ingestion ────────────────────────────────────────────────────────────

export async function ingestSource(env, source) {
  let items;
  try {
    items = await fetchAndParseRSS(source.feed_url);
  } catch (err) {
    log.warn({
      event: "rss_fetch_fail",
      sourceId: source.id,
      name: source.name,
      ...log.fmtError(err)
    });
    await markSourceFetched(env, source.id);
    return { fetched: 0, stored: 0, queued: 0 };
  }

  log.info({
    event: "rss_fetched",
    sourceId: source.id,
    name: source.name,
    itemCount: items.length
  });

  let stored = 0;
  let queued = 0;
  const dailyLimit = rssMediaDailyLimit(env);

  for (let rank = 0; rank < items.length; rank++) {
    const item = items[rank];
    if (!item.url || !item.title) continue;

    try {
      const canonicalUrl = canonicalizeUrl(item.url);
      const storyId = await urlToStoryId(canonicalUrl);
      const publishedAt = item.publishedAt
        ? new Date(item.publishedAt).toISOString()
        : new Date().toISOString();

      const inserted = await insertRSSItem(env, {
        storyId,
        sourceId: source.id,
        guid: item.guid ?? item.url,
        url: item.url,
        canonicalUrl,
        title: item.title,
        description: item.description || null,
        author: item.author || null,
        publishedAt
      });

      if (!inserted) continue; // already seen this (source, guid) pair

      stored++;

      // Register in feed_entries so it enters the recommendation candidate pool
      await storeStory(env, storyId, source.category, rank);

      // Seed story_content with the RSS description as an initial text cache.
      // resolveArticleContent will use this as a fallback before attempting a URL crawl.
      if (item.description) {
        await storeReadableContent(env, {
          storyId,
          sourceKind: "rss",
          extractedText: item.description,
          updatedAt: new Date().toISOString()
        });
      }

      // Quality gate before queuing media generation
      const qualityScore = computeRSSQualityScore(item, source);
      if (qualityScore < RSS_MEDIA_QUALITY_THRESHOLD) {
        log.debug({
          event: "rss_quality_gate_fail",
          storyId,
          qualityScore: qualityScore.toFixed(3),
          threshold: RSS_MEDIA_QUALITY_THRESHOLD
        });
        continue;
      }

      const reserved = await reserveMediaQueueSlot(env, {
        storyId,
        updatedAt: new Date().toISOString(),
        dailyLimit
      });

      if (!reserved) {
        log.debug({ event: "media_enqueue_skip", storyId, source: source.name });
        continue;
      }

      try {
        await env.MEDIA_QUEUE.send({
          storyId,
          endpoint: source.category,
          url: item.url,
          title: item.title
        });
        queued++;
        log.debug({ event: "rss_queued", storyId, source: source.name });
      } catch (err) {
        await releaseMediaQueueSlot(env, storyId);
        log.warn({ event: "rss_queue_fail", storyId, ...log.fmtError(err) });
      }
    } catch (err) {
      log.warn({
        event: "rss_item_fail",
        sourceId: source.id,
        url: item.url,
        ...log.fmtError(err)
      });
    }
  }

  await markSourceFetched(env, source.id);
  log.info({
    event: "rss_ingest_done",
    sourceId: source.id,
    name: source.name,
    fetched: items.length,
    stored,
    queued
  });
  return { fetched: items.length, stored, queued };
}

export async function ingestCategory(env, category) {
  const sources = await getRSSSources(env, {
    category,
    activeOnly: true,
    dueForFetch: true
  });

  log.info({ event: "rss_category_start", category, sourceCount: sources.length });

  let totalFetched = 0;
  let totalStored = 0;
  let totalQueued = 0;

  for (const source of sources) {
    const result = await ingestSource(env, source);
    totalFetched += result.fetched;
    totalStored += result.stored;
    totalQueued += result.queued;
  }

  log.info({
    event: "rss_category_done",
    category,
    sources: sources.length,
    fetched: totalFetched,
    stored: totalStored,
    queued: totalQueued
  });

  return {
    sources: sources.length,
    fetched: totalFetched,
    stored: totalStored,
    queued: totalQueued
  };
}
