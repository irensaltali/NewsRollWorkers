import * as log from "./log.mjs";
import { AI_ACTIONS } from "./ai-actions.mjs";
import { getAIPromptConfig } from "./db.mjs";
import { buildPromptInput, clipPromptText, promptConfigWithFallback } from "./prompt-config.mjs";
import { crawlWithFallbackAI } from "./crawl-provider.mjs";


export function hasOpenAIConfig(env) {
  return Boolean(env?.OPENAI_API_KEY);
}

// ── Core OpenAI caller ──────────────────────────────────────────────

async function callOpenAI(env, request, options = {}) {
  if (!hasOpenAIConfig(env)) {
    log.debug({ event: "ai_skip", reason: "no_api_key" });
    return options.includeMeta ? { content: null, usage: null } : null;
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
    log.warn({ event: "ai_api_fail", status: response.status, detail: detail.slice(0, 300) });
    return options.includeMeta ? { content: null, usage: null } : null;
  }

  const data = await response.json();
  const message = data?.choices?.[0]?.message;

  if (message?.refusal) {
    log.warn({ event: "ai_refusal", refusal: message.refusal.slice(0, 300) });
    return options.includeMeta ? { content: null, usage: data?.usage ?? null } : null;
  }

  if (message?.content == null) {
    const finishReason = data?.choices?.[0]?.finish_reason;
    log.warn({ event: "ai_empty_content", finishReason, model: request.model });
    return options.includeMeta ? { content: null, usage: data?.usage ?? null } : null;
  }

  const content = message.content.trim();
  if (!content) {
    const finishReason = data?.choices?.[0]?.finish_reason;
    log.warn({ event: "ai_empty_content", finishReason, model: request.model });
    return options.includeMeta ? { content: null, usage: data?.usage ?? null } : null;
  }

  return options.includeMeta
    ? { content, usage: data?.usage ?? null }
    : content;
}

function callOpenAIStructured(env, { model, max_completion_tokens, messages, schema }, options = {}) {
  return callOpenAI(env, {
    model,
    max_completion_tokens,
    messages,
    response_format: {
      type: "json_schema",
      json_schema: schema
    }
  }, options);
}

function parseStructuredResponse(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    log.warn({ event: "ai_structured_parse_fail", detail: String(raw).slice(0, 300) });
    return null;
  }
}

function parseJsonObjectFromText(raw) {
  if (!raw) return null;

  const trimmed = String(raw).trim();
  try {
    return JSON.parse(trimmed);
  } catch {}

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {}
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {}
  }

  log.warn({ event: "ai_structured_parse_fail", detail: trimmed.slice(0, 300) });
  return null;
}

function formatBullets(items) {
  if (!Array.isArray(items)) return null;
  return items.map((b) => `• ${b}`).join("\n");
}

async function resolvePromptConfig(env, key, override = null) {
  return promptConfigWithFallback(override ?? await getAIPromptConfig(env, key), key);
}

function sanitizeString(value, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

export function validateSummary(parsed) {
  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const bullets = Array.isArray(parsed.bullets)
    ? parsed.bullets
      .map((value) => sanitizeString(value))
      .filter(Boolean)
    : [];

  return bullets.length > 0 ? bullets : null;
}

export function validateExplain(parsed, fallbackLevel) {
  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const title = sanitizeString(parsed.title);
  const level = sanitizeString(parsed.level, fallbackLevel).toLowerCase();
  if (!title || !["simple", "technical"].includes(level)) {
    return null;
  }

  const sections = Array.isArray(parsed.sections)
    ? parsed.sections
      .map((section) => ({
        heading: sanitizeString(section?.heading),
        body: sanitizeString(section?.body)
      }))
      .filter((section) => section.heading && section.body)
    : [];

  const followUps = Array.isArray(parsed.followUps)
    ? parsed.followUps
      .map((value) => sanitizeString(value))
      .filter(Boolean)
    : [];

  if (sections.length === 0) {
    return null;
  }

  return {
    title,
    sections,
    followUps,
    level
  };
}

export function formatExplainResult(explain) {
  if (!explain) {
    return null;
  }

  const sections = [];
  if (explain.title) {
    sections.push(explain.title);
  }
  for (const section of explain.sections ?? []) {
    sections.push(`${section.heading}:\n${section.body}`);
  }
  if (explain.followUps?.length) {
    sections.push("Follow-Ups:\n" + formatBullets(explain.followUps));
  }
  return sections.join("\n\n") || null;
}

// ── Public generators ───────────────────────────────────────────────

export async function generateSummary(env, storyId, title, text, options = {}) {
  const action = AI_ACTIONS.summary;
  const promptConfig = await resolvePromptConfig(env, "summary", options.promptConfig);
  const response = await callOpenAIStructured(env, {
    model: promptConfig.model ?? action.model,
    max_completion_tokens: promptConfig.maxCompletionTokens ?? action.maxTokens,
    messages: [
      {
        role: "system",
        content: promptConfig.systemPrompt
      },
      {
        role: "user",
        content: buildPromptInput(promptConfig.userPromptTemplate, {
          title,
          text: clipPromptText(text, 4000)
        })
      }
    ],
    schema: action.schema
  }, {
    includeMeta: options.includeMeta
  });
  const raw = options.includeMeta ? response?.content ?? null : response;

  const parsed = parseStructuredResponse(raw);
  const bullets = validateSummary(parsed);
  if (bullets) {
    const result = formatBullets(bullets);
    return options.includeMeta ? { result, usage: response?.usage ?? null } : result;
  }

  log.warn({
    event: "ai_summary_validation_fail",
    detail: String(raw ?? "").slice(0, 300)
  });
  return options.includeMeta ? { result: null, usage: response?.usage ?? null } : null;
}

export async function generateTranslation(env, text, targetLanguage) {
  const action = AI_ACTIONS.translation;
  const result = await callOpenAI(env, {
    model: action.model,
    max_completion_tokens: action.maxTokens,
    messages: [
      {
        role: "system",
        content: `Translate the following text to ${targetLanguage}. Maintain the original meaning and tone. Output only the translation.`
      },
      { role: "user", content: (text ?? "").slice(0, 4000) }
    ]
  });
  return result;
}

export async function generateExplain(env, payload, options = {}) {
  const action = AI_ACTIONS.explain_technical;
  const promptConfig = await resolvePromptConfig(env, action.key, options.promptConfig);
  const response = await callOpenAIStructured(env, {
    model: promptConfig.model ?? action.model,
    max_completion_tokens: promptConfig.maxCompletionTokens ?? action.maxTokens,
    messages: [
      {
        role: "system",
        content: promptConfig.systemPrompt
      },
      {
        role: "user",
        content: buildPromptInput(promptConfig.userPromptTemplate, {
          payload: JSON.stringify({
            storyId: payload.storyId,
            title: payload.title,
            text: clipPromptText(payload.text, 6000),
            level: payload.level
          })
        })
      }
    ],
    schema: action.schema
  }, {
    includeMeta: options.includeMeta
  });
  const raw = options.includeMeta ? response?.content ?? null : response;

  const parsed = parseStructuredResponse(raw);
  const normalized = validateExplain(parsed, payload.level);
  if (normalized) {
    return options.includeMeta ? { result: normalized, usage: response?.usage ?? null } : normalized;
  }

  log.warn({
    event: "ai_explain_validation_fail",
    level: payload.level,
    detail: String(raw ?? "").slice(0, 300)
  });
  return options.includeMeta ? { result: null, usage: response?.usage ?? null } : null;
}

// ── Structured Translation ──────────────────────────────────────────

function sanitizeTranslatedText(value, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

function validateStructuredTranslation(parsed, source) {
  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const story = parsed.story;
  const comments = parsed.comments;
  if (!story || typeof story !== "object" || !Array.isArray(comments)) {
    return null;
  }

  const normalizedStory = {
    id: source.story.id,
    title: sanitizeTranslatedText(story.title, source.story.title),
    text: sanitizeTranslatedText(story.text, source.story.text)
  };

  const translatedCommentsById = new Map();
  for (const comment of comments) {
    if (!comment || typeof comment !== "object") {
      return null;
    }
    if (!Number.isInteger(comment.id)) {
      return null;
    }
    translatedCommentsById.set(comment.id, sanitizeTranslatedText(comment.text));
  }

  const normalizedComments = [];
  for (const comment of source.comments) {
    if (!translatedCommentsById.has(comment.id)) {
      return null;
    }
    normalizedComments.push({
      id: comment.id,
      text: translatedCommentsById.get(comment.id)
    });
  }

  return {
    story: normalizedStory,
    comments: normalizedComments
  };
}

export async function generateStructuredTranslation(env, payload, options = {}) {
  const action = AI_ACTIONS.structured_translation;
  const promptConfig = await resolvePromptConfig(env, "translation", options.promptConfig);
  const usages = [];

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await callOpenAI(env, {
      model: promptConfig.model ?? action.model,
      max_completion_tokens: promptConfig.maxCompletionTokens ?? action.maxTokens,
      messages: [
        {
          role: "system",
          content: promptConfig.systemPrompt
        },
        {
          role: "user",
          content: buildPromptInput(promptConfig.userPromptTemplate, {
            targetLanguage: payload.targetLanguage,
            payload: JSON.stringify(payload)
          })
        }
      ]
    }, {
      includeMeta: options.includeMeta
    });
    const raw = options.includeMeta ? response?.content ?? null : response;
    if (options.includeMeta && response?.usage) {
      usages.push(response.usage);
    }

    const parsed = parseJsonObjectFromText(raw);
    const normalized = validateStructuredTranslation(parsed, payload);
    if (normalized) {
      return options.includeMeta ? { result: normalized, usages } : normalized;
    }

    log.warn({
      event: "ai_translation_validation_fail",
      attempt: attempt + 1,
      detail: String(raw ?? "").slice(0, 300)
    });
  }

  return options.includeMeta ? { result: null, usages } : null;
}

// ── Cloudflare AI Crawl Generators ──────────────────────────────────

async function generateViaCrawl(env, url, { storyId, prompt, schema, validator, validatorArgs = [], options = {} }) {
  const crawlResult = await crawlWithFallbackAI(env, url, {
    storyId,
    prompt,
    responseSchema: schema
  });

  if (!crawlResult.success || !crawlResult.json) {
    log.warn({ event: "ai_crawl_no_result", url, error: crawlResult.error });
    return options.includeMeta ? { result: null, usage: null } : null;
  }

  const validated = validator(crawlResult.json, ...validatorArgs);
  if (!validated) {
    log.warn({
      event: "ai_crawl_validation_fail",
      url,
      detail: JSON.stringify(crawlResult.json).slice(0, 300)
    });
    return options.includeMeta ? { result: null, usage: null } : null;
  }

  return options.includeMeta ? { result: validated, usage: null } : validated;
}

export async function generateSummaryViaCrawl(env, url, storyId, title, options = {}) {
  const action = AI_ACTIONS.summary;
  const promptConfig = await resolvePromptConfig(env, "summary", options.promptConfig);
  const prompt = `${promptConfig.systemPrompt}\n\n${buildPromptInput(promptConfig.userPromptTemplate, { title, text: "" })}`;

  const result = await generateViaCrawl(env, url, {
    storyId,
    prompt,
    schema: action.schema,
    validator: validateSummary,
    options
  });

  if (options.includeMeta) {
    const validated = result?.result;
    if (validated) {
      return { result: formatBullets(validated), usage: result.usage };
    }
    return { result: null, usage: null };
  }

  return result ? formatBullets(result) : null;
}

export async function generateExplainViaCrawl(env, url, storyId, title, level, options = {}) {
  const action = AI_ACTIONS.explain_technical;
  const promptConfig = await resolvePromptConfig(env, action.key, options.promptConfig);
  const prompt = `${promptConfig.systemPrompt}\n\nTitle: ${title}\nExplanation level: ${level}`;

  const result = await generateViaCrawl(env, url, {
    storyId,
    prompt,
    schema: action.schema,
    validator: validateExplain,
    validatorArgs: [level],
    options
  });

  return result;
}
