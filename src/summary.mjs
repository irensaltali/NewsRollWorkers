import * as log from "./log.mjs";
import { AI_ACTIONS } from "./ai-actions.mjs";
import { getAIPromptConfig } from "./d1.mjs";
import { buildPromptInput, clipPromptText, promptConfigWithFallback } from "./prompt-config.mjs";

export async function buildHeadlineRequest(envOrTitle, titleOrText, extractedTextArg, optionsArg = {}) {
  const hasEnvObject = typeof envOrTitle === "object" && envOrTitle !== null;
  const env = hasEnvObject ? envOrTitle : null;
  const title = hasEnvObject ? titleOrText : envOrTitle;
  const extractedText = hasEnvObject ? extractedTextArg : titleOrText;
  const options = hasEnvObject ? optionsArg : {};
  const action = AI_ACTIONS.headline;
  const promptConfig = promptConfigWithFallback(options.promptConfig ?? await getAIPromptConfig(env, "headline"), "headline");
  const inputText = buildPromptInput(promptConfig.userPromptTemplate, {
    title,
    text: clipPromptText(extractedText, 2000)
  });

  return {
    model: promptConfig.model ?? action.model,
    max_completion_tokens: promptConfig.maxCompletionTokens ?? action.maxTokens,
    messages: [
      {
        role: "system",
        content: promptConfig.systemPrompt
      },
      {
        role: "user",
        content: inputText
      }
    ]
  };
}

export async function generateHeadline(env, { storyId, title, extractedText }, options = {}) {
  if (!env.OPENAI_API_KEY) {
    log.debug({ event: "headline_skip", storyId, reason: "no_api_key" });
    return options.includeMeta
      ? { headline: null, prompt: null, usage: null }
      : { headline: null, prompt: null };
  }

  const request = await buildHeadlineRequest(env, title, extractedText, options);
  const userPrompt = request.messages.find((m) => m.role === "user")?.content ?? null;

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
    log.warn({ event: "headline_api_fail", storyId, httpStatus: response.status, detail: detail.slice(0, 300) });
    return options.includeMeta
      ? { headline: null, prompt: userPrompt, usage: null }
      : { headline: null, prompt: userPrompt };
  }

  const data = await response.json();
  const headline = data?.choices?.[0]?.message?.content?.trim() ?? null;

  if (!headline) {
    log.warn({ event: "headline_empty", storyId });
    return options.includeMeta
      ? { headline: null, prompt: userPrompt, usage: data?.usage ?? null }
      : { headline: null, prompt: userPrompt };
  }

  return options.includeMeta
    ? { headline: headline.slice(0, 200), prompt: userPrompt, usage: data?.usage ?? null }
    : { headline: headline.slice(0, 200), prompt: userPrompt };
}
