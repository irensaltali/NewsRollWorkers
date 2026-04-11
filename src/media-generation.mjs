import { fal } from "@fal-ai/client";

import * as log from "./log.mjs";
import { DEFAULT_MEDIA_TEMPLATE_SETTINGS, parsePromptSettings } from "./prompt-config.mjs";

const FAL_MODEL_ALIASES = Object.freeze({
  "flux-2-turbo": "fal-ai/flux-2/turbo"
});

function mapImageSize(value) {
  switch (value) {
    case "square":
    case "1024x1024":
      return "1024x1024";
    case "landscape_16_9":
    case "1792x1024":
      return "1792x1024";
    case "portrait_16_9":
    default:
      return "1024x1792";
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeFalModel(model, fallbackModel) {
  const resolved = String(model ?? fallbackModel).replace(/^\/+/, "");
  return FAL_MODEL_ALIASES[resolved] ?? resolved;
}

export function buildFalImageRequest(prompt, settings = {}) {
  const normalized = {
    ...DEFAULT_MEDIA_TEMPLATE_SETTINGS.image,
    ...parsePromptSettings(settings, DEFAULT_MEDIA_TEMPLATE_SETTINGS.image)
  };

  return {
    prompt,
    guidance_scale: normalized.guidance_scale,
    image_size: normalized.image_size,
    num_images: normalized.num_images,
    enable_safety_checker: normalized.enable_safety_checker,
    output_format: normalized.output_format,
    enable_prompt_expansion: normalized.enable_prompt_expansion
  };
}

async function requestFalImage(env, { prompt, model, settings, storyId = null }) {
  if (!env.FAL_API_KEY) {
    return {
      status: "failed",
      errorText: "Missing FAL_API_KEY",
      provider: "fal",
      model: normalizeFalModel(model, "fal-ai/flux-2/turbo")
    };
  }

  const resolvedModel = normalizeFalModel(model, "fal-ai/flux-2/turbo");
  const response = await fetch(`https://fal.run/${resolvedModel}`, {
    method: "POST",
    headers: {
      authorization: `Key ${env.FAL_API_KEY}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(buildFalImageRequest(prompt, settings))
  });

  const data = await response.json().catch(() => ({}));
  const billableUnitsHeader = response.headers.get("x-fal-billable-units");
  const billableUnits = billableUnitsHeader == null ? null : Number(billableUnitsHeader);
  if (!response.ok) {
    log.warn({
      event: "fal_image_failed",
      storyId,
      status: response.status,
      detail: JSON.stringify(data).slice(0, 300)
    });
    return {
      status: "failed",
      requestId: data?.request_id ?? null,
      errorText: JSON.stringify(data).slice(0, 500),
      provider: "fal",
      model: resolvedModel,
      billableUnits: Number.isFinite(billableUnits) ? billableUnits : null
    };
  }

  return {
    status: "ready",
    url: data?.images?.[0]?.url ?? null,
    requestId: data?.request_id ?? null,
    provider: "fal",
    model: resolvedModel,
    billableUnits: Number.isFinite(billableUnits) ? billableUnits : null
  };
}

async function requestOpenAIImage(env, { prompt, model, settings }) {
  if (!env.OPENAI_API_KEY) {
    return {
      status: "failed",
      errorText: "Missing OPENAI_API_KEY",
      provider: "openai",
      model: model ?? "gpt-image-1"
    };
  }

  const normalized = parsePromptSettings(settings, {});
  const resolvedModel = model ?? "gpt-image-1";
  const resolvedSize = normalized.size ?? mapImageSize(normalized.image_size);
  const resolvedQuality = normalized.quality ?? "auto";
  const response = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: resolvedModel,
      prompt,
      size: resolvedSize,
      quality: resolvedQuality,
      background: normalized.background ?? "auto"
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    return {
      status: "failed",
      errorText: JSON.stringify(data).slice(0, 500),
      provider: "openai",
      model: resolvedModel,
      requestSettings: {
        size: resolvedSize,
        quality: resolvedQuality
      }
    };
  }

  const image = data?.data?.[0];
  const url = image?.url ?? (image?.b64_json ? `data:image/png;base64,${image.b64_json}` : null);
  return {
    status: "ready",
    url,
    requestId: data?.created ? String(data.created) : null,
    provider: "openai",
    model: resolvedModel,
    requestSettings: {
      size: resolvedSize,
      quality: resolvedQuality
    }
  };
}

async function requestFalVideo(env, { prompt, model, settings }) {
  if (!env.FAL_API_KEY) {
    return {
      status: "failed",
      errorText: "Missing FAL_API_KEY",
      provider: "fal",
      model: model ?? "fal-ai/sora-2/text-to-video"
    };
  }

  fal.config({
    credentials: env.FAL_API_KEY
  });

  const resolvedModel = normalizeFalModel(model, "fal-ai/sora-2/text-to-video");
  const input = {
    prompt,
    ...DEFAULT_MEDIA_TEMPLATE_SETTINGS.video,
    ...parsePromptSettings(settings, DEFAULT_MEDIA_TEMPLATE_SETTINGS.video)
  };

  try {
    const result = await fal.subscribe(resolvedModel, {
      input,
      logs: false
    });
    return {
      status: "ready",
      url: result?.data?.video?.url ?? null,
      thumbnailUrl: result?.data?.thumbnail?.url ?? null,
      requestId: result?.requestId ?? null,
      provider: "fal",
      model: resolvedModel,
      billableUnits: null
    };
  } catch (error) {
    return {
      status: "failed",
      errorText: error instanceof Error ? error.message : String(error),
      provider: "fal",
      model: resolvedModel,
      billableUnits: null
    };
  }
}

async function pollOpenAIVideo(env, videoId) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await fetch(`https://api.openai.com/v1/videos/${videoId}`, {
      headers: {
        authorization: `Bearer ${env.OPENAI_API_KEY}`
      }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        status: "failed",
        errorText: JSON.stringify(data).slice(0, 500)
      };
    }

    if (data?.status === "completed") {
      return {
        status: "ready",
        videoId
      };
    }
    if (data?.status === "failed") {
      return {
        status: "failed",
        errorText: data?.error?.message ?? "Video generation failed"
      };
    }

    await delay(3000);
  }

  return {
    status: "failed",
    errorText: "Timed out waiting for OpenAI video generation"
  };
}

async function requestOpenAIVideo(env, { prompt, model, settings, proxyPathBase = "" }) {
  if (!env.OPENAI_API_KEY) {
    return {
      status: "failed",
      errorText: "Missing OPENAI_API_KEY",
      provider: "openai",
      model: model ?? "sora-2"
    };
  }

  const normalized = {
    ...DEFAULT_MEDIA_TEMPLATE_SETTINGS.openai_video,
    ...parsePromptSettings(settings, DEFAULT_MEDIA_TEMPLATE_SETTINGS.openai_video)
  };

  const resolvedModel = model ?? "sora-2";
  const resolvedSeconds = String(normalized.seconds ?? "4");
  const resolvedSize = normalized.size ?? "1280x720";
  const response = await fetch("https://api.openai.com/v1/videos", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: resolvedModel,
      prompt,
      seconds: resolvedSeconds,
      size: resolvedSize
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.id) {
    return {
      status: "failed",
      errorText: JSON.stringify(data).slice(0, 500),
      provider: "openai",
      model: resolvedModel,
      requestSettings: {
        seconds: resolvedSeconds,
        size: resolvedSize
      }
    };
  }

  const completed = data?.status === "completed" ? { status: "ready", videoId: data.id } : await pollOpenAIVideo(env, data.id);
  if (completed.status !== "ready") {
    return {
      ...completed,
      provider: "openai",
      model: resolvedModel,
      requestSettings: {
        seconds: resolvedSeconds,
        size: resolvedSize
      },
      requestId: data.id
    };
  }

  return {
    status: "ready",
    requestId: data.id,
    proxyPath: `${proxyPathBase}/generated/video/openai/${data.id}`,
    provider: "openai",
    model: resolvedModel,
    requestSettings: {
      seconds: resolvedSeconds,
      size: resolvedSize
    }
  };
}

export async function generateImageWithProvider(env, payload) {
  return payload.provider === "openai"
    ? requestOpenAIImage(env, payload)
    : requestFalImage(env, payload);
}

export async function generateVideoWithProvider(env, payload) {
  return payload.provider === "openai"
    ? requestOpenAIVideo(env, payload)
    : requestFalVideo(env, payload);
}

export async function proxyOpenAIVideoContent(env, videoId) {
  const response = await fetch(`https://api.openai.com/v1/videos/${videoId}/content`, {
    headers: {
      authorization: `Bearer ${env.OPENAI_API_KEY}`
    }
  });

  const headers = new Headers(response.headers);
  headers.set("cache-control", "private, max-age=300");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
