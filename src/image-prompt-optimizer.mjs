import { buildPromptInput, parsePromptSettings } from "./prompt-config.mjs";
import * as log from "./log.mjs";

export const DEFAULT_IMAGE_PROMPT_OPTIMIZER_KEY = "news_image_prompt_optimizer";
export const DEFAULT_IMAGE_PROMPT_OPTIMIZER_VERSION = "v1.1-a";
export const DEFAULT_IMAGE_PROMPT_OPTIMIZER_PROVIDER = "openai";
export const DEFAULT_IMAGE_PROMPT_OPTIMIZER_MODEL = "gpt-5.4-mini-2026-03-17";
export const DEFAULT_IMAGE_GENERATION_PROVIDER = "fal";
export const DEFAULT_IMAGE_GENERATION_MODEL = "fal-ai/flux-2/turbo";

export const IMAGE_PROMPT_VARIANT_A_TOPICS = Object.freeze([
  "world",
  "general news",
  "general",
  "business",
  "science",
  "technology",
  "tech",
  "health",
  "culture",
  "sports",
  "mixed-topic articles"
]);

export const IMAGE_PROMPT_VARIANT_B_TOPICS = Object.freeze([
  "opinion",
  "analysis",
  "editorial",
  "finance",
  "economy",
  "markets",
  "policy",
  "climate",
  "environment",
  "geopolitics",
  "long-form explainers"
]);

export const IMAGE_PROMPT_VARIANT_C_TOPICS = Object.freeze([
  "breaking",
  "breaking news",
  "politics",
  "election",
  "elections",
  "war",
  "protest",
  "protests",
  "disaster",
  "human interest",
  "human-interest",
  "public safety",
  "health reporting",
  "health",
  "local",
  "local reporting"
]);

export const IMAGE_PROMPT_VARIANT_C_EVENT_KEYWORDS = Object.freeze([
  "killed",
  "injured",
  "storm",
  "flood",
  "earthquake",
  "fire",
  "vote",
  "voted",
  "election",
  "protest",
  "strike",
  "arrested",
  "hospital",
  "evacuation",
  "ceasefire",
  "attack",
  "outage"
]);

export const IMAGE_PROMPT_VARIANT_B_SYSTEMIC_KEYWORDS = Object.freeze([
  "inflation",
  "rates",
  "regulation",
  "policy",
  "tariffs",
  "strategy",
  "forecast",
  "slowdown",
  "recession",
  "oversight",
  "supply chain",
  "surveillance",
  "governance",
  "risk"
]);

const VARIANT_A_SYSTEM_PROMPT = `You are an expert news-image prompt strategist for editorial publishers. Your job is to convert article metadata into one optimized text-to-image prompt for a news thumbnail or hero image.

Your priority order is:
1. Faithful to the story
2. Visually legible at thumbnail size
3. Curiosity-inducing without becoming misleading
4. Strong enough for modern text-to-image models to render clearly

You will receive:
- Title
- Headline
- Summary
- Topics
- Language
- Optional: Article Markdown or body excerpt

Before writing the final prompt, think silently through this sequence:
1. Classify the article type and emotional temperature: breaking news, politics, finance, technology, science, opinion, climate, health, culture, sports, or human interest.
2. Identify the core visual thesis: one dominant focal subject, one source of tension, and one curiosity hook.
3. Translate abstract concepts into concrete visual symbols, scenes, objects, or metaphors anchored in the article facts.
4. Choose the style direction that best fits the article tone.
5. Compress the scene so it still reads clearly in a 16:9 thumbnail.

Output only one final image prompt. Do not explain your reasoning.

Core rules:
- Never describe abstract nouns directly. Convert them into visual symbols, physical objects, gestures, environments, or metaphors.
- Do not invent unsupported facts, settings, people, props, numbers, or outcomes.
- Prefer one dominant subject and no more than two supporting elements.
- Build for small-size readability: clear silhouette, uncluttered background, strong contrast, off-center composition when useful.
- Avoid generic stock-photo phrasing.
- Use visual tension, juxtaposition, asymmetry, motion, or an incomplete narrative to create curiosity.
- Use the Language field to infer geography, culture, clothing, architecture, or context. Write the final prompt in clear English unless the downstream image model explicitly performs better in another language.
- If the article is sensitive, tragic, or violent, imply stakes through aftermath, symbolism, or environment instead of graphic harm unless the article clearly requires direct depiction.
- If public figures are central, prefer respectful editorial portrait framing or symbolic context over exaggerated caricature.

Build the prompt in this order:
1. Subject: the main visual anchor with 1 to 3 defining traits
2. Action or tension: what is happening, shifting, breaking, colliding, revealing, or about to happen
3. Environment: location, background, and contextual cues that reinforce the story
4. Mood: urgency, dread, optimism, fragility, ambition, intimacy, awe, or similar
5. Composition: close-up, medium shot, wide shot, aerial, bird's-eye, low angle, high angle, Dutch angle, macro, and framing direction
6. Lighting: specific setup such as rim light, volumetric side light, low-key contrast, overcast realism, diffused backlight, or neon glow
7. Color palette: specific colors or a named palette with one accent if useful
8. Style and medium: editorial illustration, photojournalism, cinematic photography, digital painting, conceptual poster, or similar
9. Quality markers: high detail, sharp focus, clean separation, rich texture, professional clarity
10. Negative constraints: no text, no watermark, no logo, no extra limbs, no distorted anatomy, no duplicated subjects, no blurry faces, no low resolution

Replace vague terms with professional image language:
- cinematic -> Kodak Vision3 500T film look, anamorphic framing, controlled contrast
- dramatic lighting -> volumetric side light with rim separation
- professional photo -> 85mm or 90mm lens, shallow depth of field, crisp focal plane
- soft lighting -> diffused side-back light
- blurred background -> shallow depth of field, soft bokeh

Tone adaptation:
- Breaking news or hard news: photojournalistic realism, urgency, grounded detail
- Politics: power symbols, institutions, tension, architectural weight
- Finance or economy: corporate or material symbolism, restrained but striking palette
- Technology or science: clean, modern, precise, conceptual
- Opinion or editorial: metaphor-forward, symbolic, magazine-cover energy
- Human interest: intimate, warm, emotionally readable
- Climate or environment: scale, fragility, contrast between beauty and threat

Silent preflight before answering:
- Is the scene understandable in under one second at thumbnail size?
- Is there one clear focal point?
- Is the image faithful to the article rather than generic to the topic?
- Did you avoid abstract wording and unsupported invention?
- Did you include composition, lighting, palette, style, and negatives?

If any answer is no, revise silently once.

Final output requirements:
- Output only the final image prompt
- Single paragraph
- 120 to 220 tokens preferred, never more than 260
- No markdown
- No bullet points
- No mention of scent, sound, or non-visual sensations`;

const VARIANT_B_SYSTEM_PROMPT = `You are an expert editorial illustration prompt designer for newsrooms. You convert article metadata into one striking image prompt designed for opinion pieces, conceptual reporting, and symbolic news thumbnails.

Your task is to turn the story into a visually concrete, metaphor-first image that feels intelligent, bold, and immediately readable at thumbnail size.

You will receive:
- Title
- Headline
- Summary
- Topics
- Language
- Optional: Article Markdown or body excerpt

Think silently before answering:
1. What is the article really about beneath the surface topic?
2. What single metaphor would communicate that idea fastest and most memorably?
3. What concrete objects, materials, or staged tension make that metaphor renderable?
4. What composition would stop scrolling and create curiosity?

Rules:
- Prefer symbolic metaphors over literal stock-photo scenes.
- Translate abstract ideas into physical symbols with tension: cracked glass, melting metal, suspended objects, collapsing structures, impossible balances, shadows, reflections, barriers, fractures, masks, thresholds.
- Use only metaphors that remain understandable without explanation.
- Keep the scene graphically simple: one hero subject, one tension mechanism, minimal supporting clutter.
- Favor editorial-illustration clarity over cinematic chaos.
- Do not invent article facts, but you may use non-literal metaphor if it stays faithful to the article's meaning.
- Avoid generic business handshakes, laptop desks, crowds staring at screens, and other overused visual cliches.

Prompt structure:
1. Main symbolic subject
2. Tension or transformation
3. Minimal environment or staging
4. Emotional charge
5. Composition and framing
6. Lighting
7. Palette
8. Style and texture
9. Quality markers
10. Negative constraints

Tone mapping:
- Finance: weight, balance, fracture, accumulation, scarcity, pressure
- Policy and politics: institutions, chess, thresholds, shadow, architecture, control
- Climate: scale, fragility, erosion, contrast between nature and threat
- Technology: precision, glow, fracture, invisibility made visible
- Opinion: sharper metaphor, bolder color contrast, magazine-cover confidence

Preflight silently:
- Could this work as a magazine cover or thumbnail?
- Is the metaphor concrete enough to render?
- Is it bold without becoming confusing?
- Is the scene cleaner and more distinctive than a literal stock-photo version?

If not, revise once before answering.

Final output:
- Output only the final image prompt
- Single paragraph
- 100 to 200 tokens preferred
- No markdown
- End with negative constraints`;

const VARIANT_C_SYSTEM_PROMPT = `You are a news photo assignment editor translating article metadata into one text-to-image prompt for a realistic, thumbnail-safe, photojournalistic news image.

Your job is to produce an image prompt that feels immediate, grounded, emotionally legible, and faithful to the article without drifting into sensationalism or generic stock imagery.

You will receive:
- Title
- Headline
- Summary
- Topics
- Language
- Optional: Article Markdown or body excerpt

Think silently:
1. What is the clearest real-world scene this story implies?
2. What moment, gesture, expression, or environmental detail carries the emotional weight?
3. What should the viewer notice first at thumbnail size?

Rules:
- Prefer believable documentary scenes over surreal symbolism.
- Use metaphor only lightly and only if realism would otherwise become generic.
- Anchor the image in a plausible setting, time of day, weather, or location context.
- Show consequence, tension, or anticipation through posture, environment, or objects.
- Keep the frame focused: one primary subject or interaction, minimal clutter, clean background separation.
- Avoid graphic gore, disaster voyeurism, and exploitative suffering.
- Avoid staged corporate stock-photo energy.
- If article details are thin, choose the most plausible, grounded scene rather than inventing dramatic specifics.

Always include:
- Subject
- Real-world action or tension
- Environment
- Mood
- Composition and lens feel
- Lighting conditions
- Color palette
- Photojournalistic style markers
- Quality markers
- Negative constraints

Tone adaptation:
- Breaking news: urgency, realism, motion, consequence
- Human interest: intimacy, dignity, warmth, lived detail
- Politics: institutional realism, guarded expressions, symbolic architecture
- Health: clean, human-centered, credible
- Climate or disaster: aftermath, scale, weather, vulnerability

Silent verification:
- Does this feel like a credible front-page or feature image?
- Is the scene emotionally readable without being melodramatic?
- Would it still make sense if cropped to a thumbnail?
- Is it article-specific rather than generic?

If any answer is no, revise once.

Final output:
- Output only the final image prompt
- Single paragraph
- 120 to 220 tokens preferred
- No markdown
- End with negative constraints`;

const ENHANCED_USER_PROMPT_TEMPLATE = `Convert the following article into one thumbnail-first image prompt for a news image generator.

Goal:
Create a visually striking image prompt that is faithful to the story, legible at thumbnail size, and strong enough to make a reader curious to open the article.

Article metadata:
Title: {{title}}
Headline: {{headline}}
Summary: {{summary}}
Topics: {{topics}}
Language: {{language}}
Article Markdown or Body Excerpt: {{markdown}}

Output contract:
- Return only the final image prompt
- Single paragraph
- No markdown
- No explanation

If the markdown field is empty, rely only on the other article metadata and do not invent facts.`;

export const DEFAULT_IMAGE_PROMPT_OPTIMIZER_CONFIG = Object.freeze({
  id: null,
  key: DEFAULT_IMAGE_PROMPT_OPTIMIZER_KEY,
  version: DEFAULT_IMAGE_PROMPT_OPTIMIZER_VERSION,
  name: "News Image Prompt Optimizer - Production Generalist",
  optimizerProvider: DEFAULT_IMAGE_PROMPT_OPTIMIZER_PROVIDER,
  optimizerModel: DEFAULT_IMAGE_PROMPT_OPTIMIZER_MODEL,
  generationProvider: DEFAULT_IMAGE_GENERATION_PROVIDER,
  generationModel: DEFAULT_IMAGE_GENERATION_MODEL,
  maxCompletionTokens: 500,
  systemPrompt: VARIANT_A_SYSTEM_PROMPT,
  userPromptTemplate: ENHANCED_USER_PROMPT_TEMPLATE,
  topicMatchers: IMAGE_PROMPT_VARIANT_A_TOPICS,
  keywordMatchers: [],
  routingPriority: 100,
  fallback: true,
  settings: {}
});

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeTopics(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((topic) => normalizeText(topic))
    .filter(Boolean);
}

function uniqueLowercase(values) {
  return [...new Set((values ?? []).map((value) => normalizeText(value).toLowerCase()).filter(Boolean))];
}

export function imagePromptOptimizerConfigWithFallback(config) {
  if (!config) {
    return clone(DEFAULT_IMAGE_PROMPT_OPTIMIZER_CONFIG);
  }

  return {
    ...clone(DEFAULT_IMAGE_PROMPT_OPTIMIZER_CONFIG),
    ...config,
    provider: config.optimizerProvider ?? config.provider ?? DEFAULT_IMAGE_PROMPT_OPTIMIZER_CONFIG.optimizerProvider,
    model: config.optimizerModel ?? config.model ?? DEFAULT_IMAGE_PROMPT_OPTIMIZER_CONFIG.optimizerModel,
    optimizerProvider: config.optimizerProvider ?? config.provider ?? DEFAULT_IMAGE_PROMPT_OPTIMIZER_CONFIG.optimizerProvider,
    optimizerModel: config.optimizerModel ?? config.model ?? DEFAULT_IMAGE_PROMPT_OPTIMIZER_CONFIG.optimizerModel,
    generationProvider: normalizeText(config.generationProvider) || DEFAULT_IMAGE_PROMPT_OPTIMIZER_CONFIG.generationProvider,
    generationModel: normalizeText(config.generationModel) || DEFAULT_IMAGE_PROMPT_OPTIMIZER_CONFIG.generationModel,
    topicMatchers: uniqueLowercase(config.topicMatchers ?? config.topic_matches ?? config.topics),
    keywordMatchers: uniqueLowercase(config.keywordMatchers ?? config.keyword_matchers),
    routingPriority: Number.isFinite(Number(config.routingPriority ?? config.routing_priority))
      ? Number(config.routingPriority ?? config.routing_priority)
      : DEFAULT_IMAGE_PROMPT_OPTIMIZER_CONFIG.routingPriority,
    fallback: config.fallback ?? config.isFallback ?? config.is_fallback ?? DEFAULT_IMAGE_PROMPT_OPTIMIZER_CONFIG.fallback,
    settings: {
      ...clone(DEFAULT_IMAGE_PROMPT_OPTIMIZER_CONFIG.settings ?? {}),
      ...parsePromptSettings(config.settings ?? config.settingsJson, DEFAULT_IMAGE_PROMPT_OPTIMIZER_CONFIG.settings ?? {})
    }
  };
}

export function buildImagePromptOptimizerInput(input) {
  return {
    title: normalizeText(input?.title),
    headline: normalizeText(input?.headline),
    summary: normalizeText(input?.summary),
    topics: normalizeTopics(input?.topics),
    language: normalizeText(input?.language).toLowerCase() || "en",
    markdown: normalizeText(input?.markdown ?? input?.articleText ?? input?.bodyExcerpt)
  };
}

export function buildImagePromptOptimizerUserPrompt(config, input) {
  const normalizedInput = buildImagePromptOptimizerInput(input);
  return buildPromptInput(config.userPromptTemplate, {
    title: normalizedInput.title,
    headline: normalizedInput.headline,
    summary: normalizedInput.summary,
    topics: normalizedInput.topics.join(", "),
    language: normalizedInput.language,
    markdown: normalizedInput.markdown
  });
}

export function matchImagePromptOptimizerConfig(config, input) {
  const normalizedInput = buildImagePromptOptimizerInput(input);
  const normalizedTopics = new Set(uniqueLowercase(normalizedInput.topics));
  const text = `${normalizedInput.title} ${normalizedInput.headline} ${normalizedInput.summary}`.toLowerCase();
  const topicMatchers = uniqueLowercase(config?.topicMatchers);
  const keywordMatchers = uniqueLowercase(config?.keywordMatchers);
  const matchedTopics = topicMatchers.filter((topic) => normalizedTopics.has(topic));
  const matchedKeywords = keywordMatchers.filter((keyword) => text.includes(keyword));

  return {
    matchedTopics,
    matchedKeywords,
    matchCount: matchedTopics.length + matchedKeywords.length
  };
}

export function selectImagePromptOptimizerConfig(configs, input) {
  const normalizedConfigs = (configs ?? []).map(imagePromptOptimizerConfigWithFallback).filter((config) => config.active !== false);
  if (normalizedConfigs.length === 0) {
    return {
      config: imagePromptOptimizerConfigWithFallback(DEFAULT_IMAGE_PROMPT_OPTIMIZER_CONFIG),
      matchedTopics: [],
      matchedKeywords: [],
      fallbackReason: "default_config"
    };
  }

  const rankedMatches = normalizedConfigs
    .map((config) => ({
      config,
      ...matchImagePromptOptimizerConfig(config, input)
    }))
    .filter((entry) => entry.matchCount > 0)
    .sort((a, b) => {
      if (b.matchCount !== a.matchCount) return b.matchCount - a.matchCount;
      if (a.config.routingPriority !== b.config.routingPriority) return a.config.routingPriority - b.config.routingPriority;
      return 0;
    });

  if (rankedMatches.length > 0) {
    const bestMatch = rankedMatches[0];
    return {
      config: bestMatch.config,
      matchedTopics: bestMatch.matchedTopics,
      matchedKeywords: bestMatch.matchedKeywords,
      fallbackReason: null
    };
  }

  const fallbackConfigs = normalizedConfigs
    .filter((config) => config.fallback)
    .sort((a, b) => a.routingPriority - b.routingPriority);

  if (fallbackConfigs.length > 0) {
    return {
      config: fallbackConfigs[0],
      matchedTopics: [],
      matchedKeywords: [],
      fallbackReason: "no_topic_match"
    };
  }

  const sorted = normalizedConfigs.sort((a, b) => a.routingPriority - b.routingPriority);
  return {
    config: sorted[0],
    matchedTopics: [],
    matchedKeywords: [],
    fallbackReason: "no_fallback_config"
  };
}

export async function generateOptimizedImagePrompt(env, input, options = {}) {
  const config = imagePromptOptimizerConfigWithFallback(options.config);
  const normalizedInput = buildImagePromptOptimizerInput(input);
  const userPrompt = buildImagePromptOptimizerUserPrompt(config, normalizedInput);
  const start = Date.now();

  if (!env?.OPENAI_API_KEY) {
    return {
      status: "failed",
      optimizedPrompt: null,
      latencyMs: 0,
      errorText: "Missing OPENAI_API_KEY",
      provider: config.optimizerProvider,
      model: config.optimizerModel,
      config,
      input: normalizedInput,
      userPrompt
    };
  }

  const request = {
    model: config.optimizerModel,
    max_completion_tokens: config.maxCompletionTokens,
    messages: [
      {
        role: "system",
        content: config.systemPrompt
      },
      {
        role: "user",
        content: userPrompt
      }
    ]
  };

  const temperature = Number(config.settings?.temperature);
  if (Number.isFinite(temperature)) {
    request.temperature = temperature;
  }

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
    log.warn({
      event: "image_prompt_optimizer_fail",
      status: response.status,
      detail: detail.slice(0, 300),
      storyId: options.storyId ?? null
    });
    return {
      status: "failed",
      optimizedPrompt: null,
      latencyMs: Date.now() - start,
      errorText: detail.slice(0, 500) || `OpenAI request failed (${response.status})`,
      provider: config.optimizerProvider,
      model: config.optimizerModel,
      config,
      input: normalizedInput,
      userPrompt
    };
  }

  const data = await response.json().catch(() => ({}));
  const raw = data?.choices?.[0]?.message?.content?.trim() ?? "";
  if (!raw) {
    return {
      status: "failed",
      optimizedPrompt: null,
      latencyMs: Date.now() - start,
      errorText: "OpenAI returned empty prompt content",
      provider: config.optimizerProvider,
      model: config.optimizerModel,
      config,
      input: normalizedInput,
      userPrompt,
      usage: data?.usage ?? null
    };
  }

  return {
    status: "ready",
    optimizedPrompt: raw.slice(0, 12000),
    latencyMs: Date.now() - start,
    errorText: null,
    provider: config.optimizerProvider,
    model: config.optimizerModel,
    config,
    input: normalizedInput,
    userPrompt,
    usage: data?.usage ?? null
  };
}
