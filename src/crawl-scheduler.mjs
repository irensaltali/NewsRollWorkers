// Poll cadence for async crawl jobs. Back-weighted: catch fast pages early,
// slow tail without burning queue reads. Cumulative time through the schedule
// is ~13min; absolute deadlines on story_media gate total wall-clock.
const POLL_SCHEDULE_SECONDS = [20, 30, 45, 60, 90, 120, 180, 240, 300];
const POLL_DEFAULT_TAIL_SECONDS = 300;

const CLOUDFLARE_DEADLINE_MS = 8 * 60 * 1000;
const FIRECRAWL_DEADLINE_MS = 10 * 60 * 1000;

const MIN_DESCRIPTION_LENGTH = 800;
const MIN_FALLBACK_DESCRIPTION_LENGTH = 200;
const TRUNCATION_PATTERNS = [
  /click to read/i,
  /read more/i,
  /continue reading/i,
  /…\s*$/,
  /\.{3}\s*$/,
  /\[\+\]\s*$/
];

export function nextPollDelaySeconds(pollCount) {
  if (!Number.isFinite(pollCount) || pollCount < 0) return POLL_SCHEDULE_SECONDS[0];
  return POLL_SCHEDULE_SECONDS[pollCount] ?? POLL_DEFAULT_TAIL_SECONDS;
}

export function crawlDeadlineFor(provider, now = new Date()) {
  const base = now instanceof Date ? now : new Date(now);
  if (provider === "firecrawl") {
    return new Date(base.getTime() + FIRECRAWL_DEADLINE_MS);
  }
  return new Date(base.getTime() + CLOUDFLARE_DEADLINE_MS);
}

export function descriptionIsSufficient(item) {
  const text = typeof item?.description === "string" ? item.description.trim() : "";
  if (text.length < MIN_DESCRIPTION_LENGTH) return false;
  const tail = text.slice(-80);
  if (TRUNCATION_PATTERNS.some((re) => re.test(tail))) return false;
  return true;
}

export function descriptionIsUsableFallback(item) {
  const text = typeof item?.description === "string" ? item.description.trim() : "";
  return text.length >= MIN_FALLBACK_DESCRIPTION_LENGTH;
}

export const __private = Object.freeze({
  POLL_SCHEDULE_SECONDS,
  CLOUDFLARE_DEADLINE_MS,
  FIRECRAWL_DEADLINE_MS,
  MIN_DESCRIPTION_LENGTH,
  MIN_FALLBACK_DESCRIPTION_LENGTH
});
