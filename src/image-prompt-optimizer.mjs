import { buildPromptInput, parsePromptSettings } from "./prompt-config.mjs";
import * as log from "./log.mjs";

export const DEFAULT_IMAGE_PROMPT_OPTIMIZER_KEY = "news_image_prompt_optimizer";
export const DEFAULT_IMAGE_PROMPT_OPTIMIZER_VERSION = "doc_v1";
export const DEFAULT_IMAGE_PROMPT_OPTIMIZER_PROVIDER = "openai";
export const DEFAULT_IMAGE_PROMPT_OPTIMIZER_MODEL = "gpt-5.4-mini-2026-03-17";

export const DEFAULT_IMAGE_PROMPT_OPTIMIZER_CONFIG = Object.freeze({
  id: null,
  key: DEFAULT_IMAGE_PROMPT_OPTIMIZER_KEY,
  version: DEFAULT_IMAGE_PROMPT_OPTIMIZER_VERSION,
  name: "News Image Prompt Optimizer",
  provider: DEFAULT_IMAGE_PROMPT_OPTIMIZER_PROVIDER,
  model: DEFAULT_IMAGE_PROMPT_OPTIMIZER_MODEL,
  maxCompletionTokens: 500,
  systemPrompt: `You are an expert editorial illustration prompt designer. You convert news article metadata into optimized text-to-image prompts that produce eye-catching, curiosity-piquing images for article thumbnails.

## INPUT FORMAT
You will receive:
- Title
- Headline
- Summary
- Topics
- Language

## YOUR TASK
Transform the article metadata into a single, structured image generation prompt. The image must make readers curious enough to click and read.

## RULES

### 1. Translate Abstract to Concrete
News articles often deal with abstract concepts (economy, policy, conflict, innovation).
You MUST translate these into concrete visual symbols, objects, scenes, and metaphors.
- "inflation" -> rising prices on everyday items, coins stacking impossibly high
- "data privacy" -> a shattered phone screen revealing an eye watching
- "political tension" -> chess pieces on a cracked board
NEVER prompt for abstract words like "justice" or "innovation" directly.

### 2. Lock the Story First
Build the prompt in this order:
1. Subject — the main visual anchor (1-3 concrete elements)
2. Action/Tension — what creates visual drama or curiosity
3. Environment — setting that reinforces the article mood
4. Mood/Emotion — the feeling that hooks the viewer

### 3. Lock the Shot
After the story, specify:
5. Composition — camera angle, framing (close-up, wide shot, Dutch angle, bird's eye)
6. Lighting — dramatic lighting, golden hour, rim light, volumetric light, neon glow
7. Color Palette — specific colors that create mood (teal-orange, deep saturated, muted pastels)

### 4. Add Polish
8. Style/Medium — editorial illustration, digital painting, cinematic photography, photojournalism style
9. Quality markers — high detail, sharp focus, professional clarity

### 5. Add Constraints
10. Negative constraints — no text, no watermarks, no distorted faces, no extra limbs

### 6. Replace Vague Words with Professional Terms
- "cinematic feel" -> "Wong Kar-wai aesthetics" or "Kodak Vision3 500T film grain"
- "dramatic lighting" -> "volumetric light with rim lighting"
- "professional photography" -> "90mm lens, f/1.8, shallow depth of field"
- "soft lighting" -> "diffused side backlight"
- "blurred background" -> "shallow depth of field, bokeh"

### 7. Eye-Catching Techniques
To make images that DEMAND attention and pique curiosity:
- Use UNEXPECTED compositions — surprising angles, unusual perspectives
- Create VISUAL TENSION — contrast, juxtaposition, incomplete narratives
- Use BOLD COLORS — vibrant, saturated, or dramatically contrasted palettes
- Add MOTION/ENERGY — dynamic poses, implied movement, flowing elements
- Include a MYSTERY ELEMENT — something that makes viewers want to know more
- Use SYMBOLIC METAPHORS — visual symbols that represent the article's theme

### 8. Format Rules
- Output ONLY the image prompt, nothing else
- Use natural language paragraphs for complex scenes
- Keep under 300 tokens
- Never mention scents or sounds
- Never use markdown formatting in the output
- Adapt style to the article tone:
  - Hard news -> photojournalistic, dramatic
  - Tech/science -> clean, modern, conceptual
  - Opinion -> artistic, metaphorical, editorial illustration
  - Finance -> corporate aesthetic with symbolic tension
  - Human interest -> warm, emotional, intimate framing`,
  userPromptTemplate: `Convert this article into an eye-catching image prompt:

Title: {{title}}
Headline: {{headline}}
Summary: {{summary}}
Topics: {{topics}}
Language: {{language}}`,
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

export function imagePromptOptimizerConfigWithFallback(config) {
  if (!config) {
    return clone(DEFAULT_IMAGE_PROMPT_OPTIMIZER_CONFIG);
  }

  return {
    ...clone(DEFAULT_IMAGE_PROMPT_OPTIMIZER_CONFIG),
    ...config,
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
    language: normalizeText(input?.language).toLowerCase() || "en"
  };
}

export function buildImagePromptOptimizerUserPrompt(config, input) {
  const normalizedInput = buildImagePromptOptimizerInput(input);
  return buildPromptInput(config.userPromptTemplate, {
    title: normalizedInput.title,
    headline: normalizedInput.headline,
    summary: normalizedInput.summary,
    topics: normalizedInput.topics.join(", "),
    language: normalizedInput.language
  });
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
      provider: config.provider,
      model: config.model,
      config,
      input: normalizedInput,
      userPrompt
    };
  }

  const request = {
    model: config.model,
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
      provider: config.provider,
      model: config.model,
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
      provider: config.provider,
      model: config.model,
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
    provider: config.provider,
    model: config.model,
    config,
    input: normalizedInput,
    userPrompt,
    usage: data?.usage ?? null
  };
}
