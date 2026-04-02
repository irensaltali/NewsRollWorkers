import * as log from "./log.mjs";
import { AI_ACTIONS } from "./ai-actions.mjs";
import * as shaped from "./shaped.mjs";
import {
  getRSSItemByStoryId,
  getPublishedStoryForEnrichment,
  updatePublishedFeedEntryEnrichment
} from "./db.mjs";

const TOPIC_KEYWORDS = {
  ai: /\b(ai|artificial intelligence|machine learning|llm|gpt|chatgpt|claude|neural net|deep learning|transformer|diffusion|openai|anthropic)\b/i,
  webdev: /\b(react|vue|angular|svelte|nextjs|next\.js|css|html|javascript|typescript|webpack|vite|tailwind|frontend|web dev)\b/i,
  systems: /\b(kernel|linux|os|operating system|syscall|memory|cpu|compiler|assembly|bare metal|embedded|rtos)\b/i,
  database: /\b(sql|postgres(?:ql)?|mysql|sqlite|redis|mongodb|database|db|query|index|nosql|d1)\b/i,
  security: /\b(security|vulnerability|hack|exploit|cve|zero.day|ransomware|encryption|auth|oauth|tls|ssl)\b/i,
  crypto: /\b(bitcoin|ethereum|blockchain|crypto|defi|nft|web3|solana|token)\b/i,
  devtools: /\b(git|docker|kubernetes|k8s|ci\/cd|terraform|devops|cli|terminal|editor|ide|vim|neovim|vscode)\b/i,
  cloud: /\b(aws|azure|gcp|cloudflare|serverless|lambda|edge|cdn|s3|cloud)\b/i,
  mobile: /\b(ios|android|swift|kotlin|react native|flutter|mobile app|iphone|ipad)\b/i,
  rust: /\b(rust|cargo|rustc|borrow checker|tokio|wasm)\b/i,
  go: /\b(golang|go lang|goroutine|go module)\b/i,
  python: /\b(python|pip|django|flask|fastapi|pandas|numpy|jupyter)\b/i,
  startup: /\b(startup|founder|yc|y combinator|seed|series [a-d]|fundrais|vc|venture|pivot|mvp|launch)\b/i,
  career: /\b(hiring|job|salary|interview|resume|layoff|remote work|burnout|engineer|developer|career)\b/i,
  science: /\b(physics|biology|chemistry|neuroscience|research|paper|study|experiment|genome|quantum)\b/i,
  hardware: /\b(chip|gpu|cpu|fpga|arm|risc.v|semiconductor|silicon|intel|amd|nvidia|apple silicon)\b/i,
  networking: /\b(tcp|udp|http|dns|bgp|network|protocol|latency|bandwidth|router|packet)\b/i,
  privacy: /\b(privacy|gdpr|tracking|surveillance|data collection|anonymity|tor|vpn)\b/i,
  open_source: /\b(open source|oss|foss|mit license|gpl|apache license|github|gitlab)\b/i,
  gaming: /\b(game|gaming|unity|unreal|godot|steam|playstation|xbox|nintendo)\b/i,
  math: /\b(math|algorithm|proof|theorem|calculus|linear algebra|statistics|probability)\b/i,
  space: /\b(space|nasa|spacex|rocket|satellite|orbit|mars|moon|asteroid|telescope)\b/i,
  energy: /\b(solar|wind|nuclear|battery|ev|electric vehicle|climate|carbon|renewable)\b/i,
  fintech: /\b(fintech|payment|stripe|banking|trading|stock|finance|investment)\b/i,
  java: /\b(java|jvm|spring|maven|gradle)\b/i,
  c_cpp: /(?:\bc\+\+(?=\W|$)|\bcpp\b|\bc programming\b)/i,
  csharp: /(?:\bc#(?=\W|$)|\bcsharp\b|(?:^|\W)\.net\b|\bdotnet\b)/i,
  ruby: /\b(ruby|rails)\b/i,
};

const KNOWN_COMPANIES = [
  "Apple", "Google", "Microsoft", "Meta", "Amazon", "Tesla", "OpenAI", "Anthropic",
  "Nvidia", "Intel", "AMD", "Qualcomm", "Samsung", "IBM", "Oracle", "Salesforce",
  "Stripe", "Uber", "Airbnb", "Netflix", "Spotify", "SpaceX", "NASA",
  "GitHub", "GitLab", "Cloudflare", "Docker", "Mozilla", "Reddit", "Y Combinator"
];

const KNOWN_PEOPLE = [
  "Elon Musk", "Sam Altman", "Jensen Huang", "Sundar Pichai", "Satya Nadella",
  "Tim Cook", "Mark Zuckerberg", "Jeff Bezos", "Linus Torvalds", "Andrew Ng",
  "Dario Amodei", "Demis Hassabis"
];

export function extractEntities(title, extractedText) {
  const combined = `${title ?? ""} ${(extractedText ?? "").slice(0, 1000)}`;
  const entities = [];
  const seen = new Set();

  for (const name of KNOWN_COMPANIES) {
    if (combined.includes(name) && !seen.has(name)) {
      entities.push({ name, type: "company" });
      seen.add(name);
    }
  }

  for (const name of KNOWN_PEOPLE) {
    if (combined.includes(name) && !seen.has(name)) {
      entities.push({ name, type: "person" });
      seen.add(name);
    }
  }

  return entities;
}

export function extractTopicsKeyword(title, extractedText) {
  const combined = `${title ?? ""} ${(extractedText ?? "").slice(0, 500)}`;
  const topics = [];

  for (const [topic, pattern] of Object.entries(TOPIC_KEYWORDS)) {
    if (pattern.test(combined)) {
      topics.push(topic);
    }
  }

  return topics.length > 0 ? topics.slice(0, 5) : ["general"];
}

export function buildTopicExtractionRequest(title, extractedText) {
  const inputText = `Title: ${title}\n\n${(extractedText ?? "").slice(0, 2000)}`;
  const action = AI_ACTIONS.topic_extraction;

  return {
    model: action.model,
    max_completion_tokens: action.maxTokens,
    messages: [
      {
        role: "system",
        content:
          "Extract 1-5 topic tags for this news story. Use lowercase, snake_case tags from this list when applicable: ai, webdev, systems, database, security, crypto, devtools, cloud, mobile, rust, go, python, java, c_cpp, csharp, ruby, startup, career, science, hardware, networking, privacy, open_source, gaming, math, space, energy, fintech. You may add one custom tag if none fit well. Output ONLY a JSON array of strings, nothing else."
      },
      {
        role: "user",
        content: inputText
      }
    ]
  };
}

export async function extractTopicsLLM(env, storyId, title, extractedText) {
  if (!env.OPENAI_API_KEY) {
    log.debug({ event: "topic_llm_skip", storyId, reason: "no_api_key" });
    return null;
  }

  const request = buildTopicExtractionRequest(title, extractedText);

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(request)
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    log.warn({ event: "topic_llm_fail", storyId, httpStatus: response.status, detail: detail.slice(0, 300) });
    return null;
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content?.trim() ?? null;
  if (!content) {
    log.warn({ event: "topic_llm_empty", storyId });
    return null;
  }

  try {
    const topics = JSON.parse(content);
    if (Array.isArray(topics) && topics.every((t) => typeof t === "string")) {
      return topics.slice(0, 5);
    }
    log.warn({ event: "topic_llm_invalid", storyId, content: content.slice(0, 200) });
    return null;
  } catch {
    log.warn({ event: "topic_llm_parse_fail", storyId, content: content.slice(0, 200) });
    return null;
  }
}

export function computeQualityScore(story) {
  const score = story.score ?? 0;
  const comments = story.commentCount ?? story.descendants ?? 0;
  const endpoint = story.sourceEndpoint ?? "front";

  const endpointBoost = {
    front: 0.15,
    best: 0.20,
    show: 0.10,
    ask: 0.05,
    new: 0.0,
    jobs: -0.05,
    active: 0.10
  };

  const scoreComponent = Math.min(score / 500, 1.0) * 0.5;
  const commentComponent = Math.min(comments / 200, 1.0) * 0.3;
  const boost = endpointBoost[endpoint] ?? 0;

  return Math.max(0, Math.min(1, scoreComponent + commentComponent + 0.2 + boost));
}

export function computeNoveltyScore(publishedAt) {
  if (!publishedAt) return 0.5;

  const publishTime = new Date(publishedAt).getTime();
  const now = Date.now();
  const hoursAgo = (now - publishTime) / (1000 * 60 * 60);

  if (hoursAgo <= 0) return 1.0;
  if (hoursAgo >= 48) return 0.1;

  return 1.0 - (0.9 * hoursAgo) / 48;
}

export async function enrichPublishedStory(env, storyId, { crawlMetadata = null } = {}) {
  if (!env?.SUPABASE_URL) return;

  const row = await getPublishedStoryForEnrichment(env, storyId);

  if (!row) {
    log.debug({ event: "enrich_skip", storyId, reason: "not_found" });
    return;
  }

  const crawlTopics = Array.isArray(crawlMetadata?.topics)
    ? crawlMetadata.topics.filter((topic) => typeof topic === "string" && topic.trim().length > 0).slice(0, 5)
    : [];
  const topics = crawlTopics.length > 0
    ? crawlTopics
    : extractTopicsKeyword("", row.extractedText ?? "");
  const noveltyScore = computeNoveltyScore(row.publishedAt);
  const entities = extractEntities("", row.extractedText ?? "");
  const articleLength = (row.extractedText ?? "").length || null;

  const rssItem = await getRSSItemByStoryId(env, storyId);
  const publisher         = rssItem?.sourceName ?? null;
  const publisherTier     = rssItem?.sourceTier ?? 2;
  const sourceReliability = rssItem?.sourceReliability ?? null;
  const hasAuthor         = Boolean(rssItem?.author);
  const sourceCount       = rssItem?.sourceCount ?? 1;
  const language          = typeof crawlMetadata?.language === "string" && crawlMetadata.language.trim().length > 0
    ? crawlMetadata.language.trim()
    : (rssItem?.sourceLanguage ?? "en");

  const qualityScore = sourceReliability != null
    ? sourceReliability
    : computeQualityScore({ sourceEndpoint: row.sourceEndpoint });

  await updatePublishedFeedEntryEnrichment(env, storyId, {
    topics,
    qualityScore,
    noveltyScore,
    language,
    entities,
    articleLength,
    topicCount: topics.length,
    entityCount: entities.length,
    hasAuthor,
    publisher,
    publisherTier,
    sourceReliabilityScore: sourceReliability ?? 0.5
  });

  log.info({
    event: "enriched", storyId, topics, qualityScore, noveltyScore,
    entityCount: entities.length, publisher, publisherTier, sourceCount
  });

  // Fire-and-forget: sync to Shaped catalog (idempotent; cron velocity refresh will re-sync)
  shaped.upsertItem(env, {
    storyId,
    publishedAt: row.publishedAt,
    sourceEndpoint: row.sourceEndpoint,
    topics,
    language,
    entities,
    qualityScore,
    noveltyScore,
    articleLength,
    topicCount: topics.length,
    entityCount: entities.length,
    hasAuthor,
    publisher,
    publisherTier,
    sourceReliabilityScore: sourceReliability ?? 0.5,
    duplicateClusterSize: sourceCount
  }).catch(() => {});
}
