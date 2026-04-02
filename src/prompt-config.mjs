export const AI_PROMPT_KEYS = Object.freeze([
  "headline",
  "summary",
  "translation",
  "thread_intelligence",
  "explain_simple",
  "explain_technical"
]);

export const DEFAULT_AI_PROMPT_CONFIGS = Object.freeze({
  headline: Object.freeze({
    key: "headline",
    name: "AI Headline",
    provider: "openai",
    model: "o4-mini",
    maxCompletionTokens: 150,
    systemPrompt:
      "Write a single-sentence hook summary for the following article. Keep it under 120 characters. Create a sense of mystery or intrigue. No emojis, no clickbait. Output only the summary sentence, nothing else.",
    userPromptTemplate: "Title: {{title}}\n\n{{text}}",
    settings: {}
  }),
  summary: Object.freeze({
    key: "summary",
    name: "Story Summary",
    provider: "openai",
    model: "o4-mini",
    maxCompletionTokens: 2000,
    systemPrompt:
      "You are a concise tech news analyst. Summarize the following article in 3-5 bullet points. Focus on key facts, implications, and why it matters. No fluff.",
    userPromptTemplate: "Title: {{title}}\n\n{{text}}",
    settings: {}
  }),
  translation: Object.freeze({
    key: "translation",
    name: "Structured Translation",
    provider: "openai",
    model: "o1-mini",
    maxCompletionTokens: 16000,
    systemPrompt:
      "You translate news content into the requested language. Return valid JSON only. Preserve IDs exactly. Translate only human-readable text fields. Do not include markdown fences or commentary.",
    userPromptTemplate:
      'Target language: {{targetLanguage}}.\n\nTranslate the following structured JSON and respond with an object shaped like:\n{"story":{"title":"...","text":"..."},"comments":[{"id":123,"text":"..."}]}\n\n{{payload}}',
    settings: {}
  }),
  thread_intelligence: Object.freeze({
    key: "thread_intelligence",
    name: "Thread Intelligence",
    provider: "openai",
    model: "o4-mini",
    maxCompletionTokens: 3000,
    systemPrompt:
      "You analyze news comment threads. Summarize the overall discussion, extract the highest-signal insights, and classify the discussion shape as heated, consensus, or mixed. Base your answer only on the provided thread content.",
    userPromptTemplate: "{{payload}}",
    settings: {}
  }),
  explain_simple: Object.freeze({
    key: "explain_simple",
    name: "Explain Simple",
    provider: "openai",
    model: "o4-mini",
    maxCompletionTokens: 4000,
    systemPrompt:
      "Explain this tech article in plain language for an informed general reader. Avoid jargon where possible, define important terms briefly, and focus on the core idea and impact.",
    userPromptTemplate: "{{payload}}",
    settings: {}
  }),
  explain_technical: Object.freeze({
    key: "explain_technical",
    name: "Explain Technical",
    provider: "openai",
    model: "o4-mini",
    maxCompletionTokens: 4000,
    systemPrompt:
      "Explain this tech article for a technical reader. Preserve precise terminology, architecture details, tradeoffs, and implementation implications.",
    userPromptTemplate: "{{payload}}",
    settings: {}
  })
});

export const DEFAULT_MEDIA_TEMPLATE_SETTINGS = Object.freeze({
  image: Object.freeze({
    guidance_scale: 2.5,
    image_size: "portrait_16_9",
    num_images: 1,
    enable_safety_checker: true,
    output_format: "webp",
    enable_prompt_expansion: true
  }),
  video: Object.freeze({
    duration: "4",
    aspect_ratio: "16:9",
    resolution: "720p",
    delete_video: true
  }),
  openai_video: Object.freeze({
    seconds: "4",
    size: "1280x720"
  })
});

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

export function clipPromptText(value, maxLength = 6000) {
  return typeof value === "string" ? value.slice(0, maxLength) : "";
}

export function parsePromptSettings(value, fallback = {}) {
  if (!value) {
    return clone(fallback);
  }

  if (typeof value === "object") {
    return clone(value);
  }

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : clone(fallback);
  } catch {
    return clone(fallback);
  }
}

export function renderPromptTemplate(template, variables = {}) {
  return String(template ?? "").replace(/\{\{(\w+)\}\}/g, (_match, key) => {
    const value = variables[key];
    return value == null ? "" : String(value);
  });
}

export function promptConfigWithFallback(config, fallbackKey) {
  const fallback = DEFAULT_AI_PROMPT_CONFIGS[fallbackKey];
  if (!fallback) {
    return null;
  }

  if (!config) {
    return clone(fallback);
  }

  return {
    ...clone(fallback),
    ...config,
    settings: {
      ...clone(fallback.settings ?? {}),
      ...parsePromptSettings(config.settings ?? config.settingsJson, fallback.settings ?? {})
    }
  };
}

export function mediaTemplateWithFallback(template, modality = "image") {
  if (template) {
    return {
      ...template,
      settings: parsePromptSettings(
        template.settings ?? template.settingsJson,
        template.provider === "openai" && modality === "video"
          ? DEFAULT_MEDIA_TEMPLATE_SETTINGS.openai_video
          : DEFAULT_MEDIA_TEMPLATE_SETTINGS[modality] ?? {}
      )
    };
  }

  const fallbackSettings = modality === "video"
    ? DEFAULT_MEDIA_TEMPLATE_SETTINGS.video
    : DEFAULT_MEDIA_TEMPLATE_SETTINGS.image;

  return {
    id: null,
    name: `${modality}_default`,
    description: null,
    templateText: modality === "video"
      ? 'Create a short editorial video for the news story "{{title}}". Use grounded, product-focused motion and visual transitions inspired by this source context: {{sourceText}}'
      : 'Editorial illustration for news story "{{title}}". Focus on product, engineering, and startup themes. Use clean composition. Source context: {{sourceText}}',
    active: 1,
    modality,
    provider: modality === "video" ? "fal" : "fal",
    model: modality === "video" ? "fal-ai/sora-2/text-to-video" : "fal-ai/flux-2/turbo",
    settings: clone(fallbackSettings)
  };
}

export function buildPromptInput(templateText, variables) {
  return clipPromptText(renderPromptTemplate(templateText, variables), 12000);
}

const CLOUDFLARE_USER_PROMPT_DEFAULTS = Object.freeze({
  summary: "The article title is '{{title}}'. Summarize the page content in 3-5 concise bullet points focusing on key facts, implications, and why it matters.",
  explain_simple: "The article title is '{{title}}'. Explain this article in plain language for an informed general reader. Avoid jargon, define important terms briefly, and focus on the core idea and impact. Provide 2-4 explanation sections and follow-up questions.",
  explain_technical: "The article title is '{{title}}'. Explain this article for a technical reader. Preserve precise terminology, architecture details, tradeoffs, and implementation implications. Provide 2-4 explanation sections and follow-up questions."
});

export function getDefaultUserPromptForProvider(promptKey, provider) {
  if (provider === "cloudflare" && CLOUDFLARE_USER_PROMPT_DEFAULTS[promptKey]) {
    return CLOUDFLARE_USER_PROMPT_DEFAULTS[promptKey];
  }
  return DEFAULT_AI_PROMPT_CONFIGS[promptKey]?.userPromptTemplate ?? "";
}
