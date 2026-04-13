const ONE_MILLION = 1_000_000;
const MODEL_CATALOG_TTL_MS = 5 * 60 * 1000;

const OPENAI_SUPPORTED_MODELS = Object.freeze({
  text: Object.freeze([
    Object.freeze({
      id: "gpt-5.4-mini-2026-03-17",
      label: "gpt-5.4-mini-2026-03-17",
      pricing: Object.freeze({
        type: "tokens",
        currency: "USD",
        inputPer1M: 1.1,
        cachedInputPer1M: 0.275,
        outputPer1M: 4.4,
        display: "$1.10 input / $0.275 cached input / $4.40 output per 1M tokens"
      })
    })
  ]),
  image: Object.freeze([
    Object.freeze({
      id: "gpt-image-1",
      label: "gpt-image-1",
      pricing: Object.freeze({
        type: "image",
        currency: "USD",
        textInputPer1M: 5,
        cachedTextInputPer1M: 1.25,
        imageOutputPer1M: 40,
        squarePrices: Object.freeze({
          low: 0.011,
          medium: 0.042,
          high: 0.167
        }),
        display: "~$0.011 to $0.167 per image depending on quality and size"
      })
    })
  ]),
  video: Object.freeze([
    Object.freeze({
      id: "sora-2",
      label: "sora-2",
      pricing: Object.freeze({
        type: "video_seconds",
        currency: "USD",
        sizePrices: Object.freeze({
          "1280x720": 0.1,
          "720x1280": 0.1
        }),
        display: "~$0.10 per second at 1280x720 or 720x1280"
      })
    })
  ])
});

const FAL_SUPPORTED_MODELS = Object.freeze({
  image: Object.freeze([
    Object.freeze({
      id: "fal-ai/flux-2/turbo",
      label: "fal-ai/flux-2/turbo",
      aliases: Object.freeze(["flux-2-turbo"])
    })
  ]),
  video: Object.freeze([
    Object.freeze({
      id: "fal-ai/sora-2/text-to-video",
      label: "fal-ai/sora-2/text-to-video",
      aliases: Object.freeze([])
    })
  ])
});

let modelCatalogCache = null;

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function nowIso() {
  return new Date().toISOString();
}

function roundMoney(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function formatUsd(value) {
  if (!Number.isFinite(value)) {
    return "Unavailable";
  }
  if (value === 0) {
    return "$0.0000";
  }
  if (value >= 1) {
    return `$${value.toFixed(2)}`;
  }
  if (value >= 0.01) {
    return `$${value.toFixed(4)}`;
  }
  return `$${value.toFixed(6)}`;
}

function buildCostResponse({ costUsd = null, estimated = false, pricingSource = null, details = null, unavailableReason = null } = {}) {
  const normalizedCost = Number.isFinite(costUsd) ? roundMoney(costUsd) : null;
  return {
    costUsd: normalizedCost,
    costCurrency: normalizedCost == null ? null : "USD",
    costDisplay: normalizedCost == null ? "Unavailable" : `${estimated ? "~" : ""}${formatUsd(normalizedCost)}`,
    costEstimated: normalizedCost == null ? false : Boolean(estimated),
    pricingSource,
    costDetails: details ?? (unavailableReason ? { unavailableReason } : null)
  };
}

function modalityOrDefault(value, fallback = "text") {
  return value === "image" || value === "video" ? value : fallback;
}

function getFalDefinition(modelId, modality) {
  const normalizedModel = String(modelId ?? "");
  const models = FAL_SUPPORTED_MODELS[modalityOrDefault(modality, "image")] ?? [];
  return models.find((model) => model.id === normalizedModel || (model.aliases ?? []).includes(normalizedModel)) ?? null;
}

function getOpenAIDefinition(modelId, modality) {
  const normalizedModel = String(modelId ?? "");
  const models = OPENAI_SUPPORTED_MODELS[modalityOrDefault(modality)] ?? [];
  return models.find((model) => model.id === normalizedModel) ?? null;
}

function createOpenAIOption(definition, modality, { live = true } = {}) {
  return {
    id: definition.id,
    label: definition.label,
    provider: "openai",
    modality,
    live,
    pricingSource: "openai_static_registry",
    pricing: {
      ...clone(definition.pricing),
      available: true
    }
  };
}

function createFalOption(definition, modality, price = null, { live = true } = {}) {
  return {
    id: definition.id,
    label: definition.label,
    provider: "fal",
    modality,
    live,
    pricingSource: price ? "fal_platform_pricing" : null,
    pricing: price
      ? {
        type: "unit",
        currency: price.currency ?? "USD",
        unit: price.unit ?? "unit",
        unitPriceUsd: Number(price.unitPrice ?? 0),
        display: `${formatUsd(Number(price.unitPrice ?? 0))} / ${price.unit ?? "unit"}`,
        available: true
      }
      : {
        available: false,
        display: "Pricing unavailable"
      }
  };
}

function createFallbackCatalog() {
  return {
    providers: {
      openai: {
        text: OPENAI_SUPPORTED_MODELS.text.map((model) => createOpenAIOption(model, "text", { live: false })),
        image: OPENAI_SUPPORTED_MODELS.image.map((model) => createOpenAIOption(model, "image", { live: false })),
        video: OPENAI_SUPPORTED_MODELS.video.map((model) => createOpenAIOption(model, "video", { live: false }))
      },
      fal: {
        image: FAL_SUPPORTED_MODELS.image.map((model) => createFalOption(model, "image", null, { live: false })),
        video: FAL_SUPPORTED_MODELS.video.map((model) => createFalOption(model, "video", null, { live: false }))
      }
    },
    defaults: {
      openai: {
        text: OPENAI_SUPPORTED_MODELS.text[0]?.id ?? "",
        image: OPENAI_SUPPORTED_MODELS.image[0]?.id ?? "",
        video: OPENAI_SUPPORTED_MODELS.video[0]?.id ?? ""
      },
      fal: {
        image: FAL_SUPPORTED_MODELS.image[0]?.id ?? "",
        video: FAL_SUPPORTED_MODELS.video[0]?.id ?? ""
      }
    },
    fetchedAt: null,
    stale: true
  };
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, init);
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Request failed (${response.status}) for ${url}: ${detail.slice(0, 200)}`);
  }
  return response.json();
}

async function fetchOpenAILiveIds(env) {
  if (!env.OPENAI_API_KEY) {
    return null;
  }

  const payload = await fetchJson("https://api.openai.com/v1/models", {
    headers: {
      authorization: `Bearer ${env.OPENAI_API_KEY}`
    }
  });

  const models = Array.isArray(payload?.data) ? payload.data : [];
  return new Set(
    models
      .map((model) => String(model?.id ?? "").trim())
      .filter(Boolean)
  );
}

function normalizeFalSearchModel(model) {
  const endpointId = String(model?.endpoint_id ?? model?.endpointId ?? model?.id ?? "").trim();
  if (!endpointId) {
    return null;
  }

  return {
    endpointId,
    displayName: String(model?.display_name ?? model?.displayName ?? endpointId).trim() || endpointId,
    status: String(model?.status ?? "").trim().toLowerCase() || null
  };
}

async function fetchFalLiveModels(env) {
  const url = new URL("https://api.fal.ai/v1/models");
  for (const model of [...FAL_SUPPORTED_MODELS.image, ...FAL_SUPPORTED_MODELS.video]) {
    url.searchParams.append("endpoint_id", model.id);
  }

  const headers = {};
  if (env.FAL_API_KEY) {
    headers.authorization = `Key ${env.FAL_API_KEY}`;
  }

  const payload = await fetchJson(url.toString(), { headers });
  const models = payload?.models ?? payload?.results ?? payload?.data ?? [];
  return new Map(
    models
      .map(normalizeFalSearchModel)
      .filter(Boolean)
      .filter((model) => model.status == null || model.status === "active")
      .map((model) => [model.endpointId, model])
  );
}

function normalizeFalPrice(price) {
  const endpointId = String(price?.endpoint_id ?? price?.endpointId ?? "").trim();
  if (!endpointId) {
    return null;
  }

  return {
    endpointId,
    unitPrice: Number(price?.unit_price ?? price?.unitPrice ?? 0),
    unit: String(price?.unit ?? "unit").trim() || "unit",
    currency: String(price?.currency ?? "USD").trim() || "USD"
  };
}

async function fetchFalPricing(env) {
  if (!env.FAL_API_KEY) {
    return new Map();
  }

  const url = new URL("https://api.fal.ai/v1/models/pricing");
  for (const model of [...FAL_SUPPORTED_MODELS.image, ...FAL_SUPPORTED_MODELS.video]) {
    url.searchParams.append("endpoint_id", model.id);
  }

  const payload = await fetchJson(url.toString(), {
    headers: {
      authorization: `Key ${env.FAL_API_KEY}`
    }
  });

  const prices = Array.isArray(payload?.prices) ? payload.prices : [];
  return new Map(
    prices
      .map(normalizeFalPrice)
      .filter(Boolean)
      .map((price) => [price.endpointId, price])
  );
}

function buildDynamicCatalog({ openAILiveIds, falLiveModels, falPricing, stale = false }) {
  const openai = {
    text: OPENAI_SUPPORTED_MODELS.text
      .filter((model) => !openAILiveIds || openAILiveIds.has(model.id))
      .map((model) => createOpenAIOption(model, "text", { live: Boolean(openAILiveIds?.has(model.id)) })),
    image: OPENAI_SUPPORTED_MODELS.image
      .filter((model) => !openAILiveIds || openAILiveIds.has(model.id))
      .map((model) => createOpenAIOption(model, "image", { live: Boolean(openAILiveIds?.has(model.id)) })),
    video: OPENAI_SUPPORTED_MODELS.video
      .filter((model) => !openAILiveIds || openAILiveIds.has(model.id))
      .map((model) => createOpenAIOption(model, "video", { live: Boolean(openAILiveIds?.has(model.id)) }))
  };

  const fal = {
    image: FAL_SUPPORTED_MODELS.image
      .filter((model) => falLiveModels == null || falLiveModels.has(model.id))
      .map((model) => {
        const liveModel = falLiveModels?.get(model.id);
        const price = falPricing?.get(model.id) ?? null;
        return {
          ...createFalOption(model, "image", price, { live: Boolean(liveModel) }),
          label: liveModel?.displayName ?? model.label
        };
      }),
    video: FAL_SUPPORTED_MODELS.video
      .filter((model) => falLiveModels == null || falLiveModels.has(model.id))
      .map((model) => {
        const liveModel = falLiveModels?.get(model.id);
        const price = falPricing?.get(model.id) ?? null;
        return {
          ...createFalOption(model, "video", price, { live: Boolean(liveModel) }),
          label: liveModel?.displayName ?? model.label
        };
      })
  };

  return {
    providers: {
      openai,
      fal
    },
    defaults: {
      openai: {
        text: openai.text[0]?.id ?? OPENAI_SUPPORTED_MODELS.text[0]?.id ?? "",
        image: openai.image[0]?.id ?? OPENAI_SUPPORTED_MODELS.image[0]?.id ?? "",
        video: openai.video[0]?.id ?? OPENAI_SUPPORTED_MODELS.video[0]?.id ?? ""
      },
      fal: {
        image: fal.image[0]?.id ?? FAL_SUPPORTED_MODELS.image[0]?.id ?? "",
        video: fal.video[0]?.id ?? FAL_SUPPORTED_MODELS.video[0]?.id ?? ""
      }
    },
    fetchedAt: nowIso(),
    stale
  };
}

export function normalizePersistedCostFields(row) {
  const costDetails = row?.costDetails ?? row?.costDetailsJson;
  const parsedCostDetails = typeof costDetails === "string"
    ? (() => {
      try {
        return JSON.parse(costDetails);
      } catch {
        return null;
      }
    })()
    : costDetails ?? null;

  return buildCostResponse({
    costUsd: row?.costUsd ?? null,
    estimated: Number(row?.costEstimated ?? 0) === 1 || row?.costEstimated === true,
    pricingSource: row?.pricingSource ?? null,
    details: parsedCostDetails
  });
}

export function serializeCostFields(cost) {
  return {
    costUsd: Number.isFinite(cost?.costUsd) ? roundMoney(cost.costUsd) : null,
    costCurrency: cost?.costCurrency ?? null,
    costEstimated: cost?.costUsd == null ? null : (cost.costEstimated ? 1 : 0),
    pricingSource: cost?.pricingSource ?? null,
    costDetailsJson: cost?.costDetails ? JSON.stringify(cost.costDetails) : null
  };
}

export function findCatalogModel(catalog, { provider, modality, model }) {
  const providerKey = provider === "fal" ? "fal" : "openai";
  const modalityKey = modalityOrDefault(modality, providerKey === "openai" ? "text" : "image");
  const models = catalog?.providers?.[providerKey]?.[modalityKey] ?? [];
  const normalizedModel = String(model ?? "").trim();
  return models.find((entry) => entry.id === normalizedModel) ?? null;
}

function normalizeOpenAIUsage(usage) {
  if (!usage || typeof usage !== "object") {
    return null;
  }

  const promptTokens = Number(usage.prompt_tokens ?? usage.promptTokens ?? 0);
  const completionTokens = Number(usage.completion_tokens ?? usage.completionTokens ?? 0);
  const cachedPromptTokens = Number(
    usage?.prompt_tokens_details?.cached_tokens
      ?? usage?.promptTokensDetails?.cachedTokens
      ?? usage?.cachedPromptTokens
      ?? 0
  );

  return {
    promptTokens,
    completionTokens,
    cachedPromptTokens: Math.min(promptTokens, Math.max(cachedPromptTokens, 0))
  };
}

export function mergeOpenAIUsages(...usages) {
  const normalized = usages
    .map(normalizeOpenAIUsage)
    .filter(Boolean);

  if (normalized.length === 0) {
    return null;
  }

  return normalized.reduce((accumulator, usage) => ({
    promptTokens: accumulator.promptTokens + usage.promptTokens,
    completionTokens: accumulator.completionTokens + usage.completionTokens,
    cachedPromptTokens: accumulator.cachedPromptTokens + usage.cachedPromptTokens
  }), {
    promptTokens: 0,
    completionTokens: 0,
    cachedPromptTokens: 0
  });
}

export function calculateOpenAITextCost(modelId, usage) {
  const definition = getOpenAIDefinition(modelId, "text");
  const normalizedUsage = normalizeOpenAIUsage(usage);
  if (!definition || !normalizedUsage) {
    return buildCostResponse({
      pricingSource: definition ? "openai_static_registry" : null,
      unavailableReason: "Missing usage or pricing"
    });
  }

  const pricing = definition.pricing;
  const uncachedPromptTokens = Math.max(normalizedUsage.promptTokens - normalizedUsage.cachedPromptTokens, 0);
  const costUsd = (
    uncachedPromptTokens * pricing.inputPer1M
    + normalizedUsage.cachedPromptTokens * pricing.cachedInputPer1M
    + normalizedUsage.completionTokens * pricing.outputPer1M
  ) / ONE_MILLION;

  return buildCostResponse({
    costUsd,
    estimated: false,
    pricingSource: "openai_static_registry",
    details: {
      type: "tokens",
      promptTokens: normalizedUsage.promptTokens,
      cachedPromptTokens: normalizedUsage.cachedPromptTokens,
      completionTokens: normalizedUsage.completionTokens,
      inputPer1M: pricing.inputPer1M,
      cachedInputPer1M: pricing.cachedInputPer1M,
      outputPer1M: pricing.outputPer1M
    }
  });
}

function parseImageSize(value) {
  const match = String(value ?? "").match(/^(\d+)x(\d+)$/);
  if (!match) {
    return null;
  }
  return {
    width: Number(match[1]),
    height: Number(match[2])
  };
}

export function normalizeOpenAIImagePriceInputs(settings = {}) {
  const size = String(settings.size ?? "").trim() || "1024x1024";
  const requestedQuality = String(settings.quality ?? "auto").trim().toLowerCase() || "auto";
  const quality = requestedQuality === "auto" ? "medium" : requestedQuality;
  const count = Math.max(1, Number(settings.num_images ?? 1) || 1);
  return { size, quality, requestedQuality, count };
}

export function calculateOpenAIImageCost(modelId, settings = {}) {
  const definition = getOpenAIDefinition(modelId, "image");
  if (!definition) {
    return buildCostResponse({
      unavailableReason: "Missing pricing"
    });
  }

  const pricing = definition.pricing;
  const normalized = normalizeOpenAIImagePriceInputs(settings);
  const size = parseImageSize(normalized.size);
  const baseSquarePrice = pricing.squarePrices[normalized.quality];
  if (!size || !baseSquarePrice) {
    return buildCostResponse({
      pricingSource: "openai_static_registry",
      unavailableReason: "Unsupported size or quality"
    });
  }

  const areaRatio = (size.width * size.height) / (1024 * 1024);
  const unitPriceUsd = baseSquarePrice * areaRatio;
  return buildCostResponse({
    costUsd: unitPriceUsd * normalized.count,
    estimated: true,
    pricingSource: "openai_static_registry",
    details: {
      type: "image",
      size: normalized.size,
      quality: normalized.quality,
      requestedQuality: normalized.requestedQuality,
      images: normalized.count,
      unitPriceUsd: roundMoney(unitPriceUsd)
    }
  });
}

export function calculateOpenAIVideoCost(modelId, settings = {}) {
  const definition = getOpenAIDefinition(modelId, "video");
  if (!definition) {
    return buildCostResponse({
      unavailableReason: "Missing pricing"
    });
  }

  const size = String(settings.size ?? "1280x720").trim() || "1280x720";
  const seconds = Math.max(1, Number(settings.seconds ?? 4) || 4);
  const unitPriceUsd = definition.pricing.sizePrices[size];
  if (!unitPriceUsd) {
    return buildCostResponse({
      pricingSource: "openai_static_registry",
      unavailableReason: "Unsupported size"
    });
  }

  return buildCostResponse({
    costUsd: unitPriceUsd * seconds,
    estimated: true,
    pricingSource: "openai_static_registry",
    details: {
      type: "video_seconds",
      size,
      seconds,
      unitPriceUsd
    }
  });
}

export function calculateFalMediaCost(catalog, { model, modality, settings = {}, billableUnits = null }) {
  const definition = getFalDefinition(model, modality);
  const catalogModel = definition ? findCatalogModel(catalog, { provider: "fal", modality, model: definition.id }) : null;
  const unitPriceUsd = Number(catalogModel?.pricing?.unitPriceUsd ?? NaN);
  const unit = catalogModel?.pricing?.unit ?? "unit";

  if (!Number.isFinite(unitPriceUsd)) {
    return buildCostResponse({
      pricingSource: catalogModel?.pricingSource ?? null,
      unavailableReason: "Missing pricing"
    });
  }

  let estimated = false;
  let resolvedBillableUnits = Number(billableUnits);
  let billableUnitSource = "provider_response";
  if (!Number.isFinite(resolvedBillableUnits) || resolvedBillableUnits <= 0) {
    estimated = true;
    if (modality === "image") {
      resolvedBillableUnits = Math.max(1, Number(settings.num_images ?? 1) || 1);
      billableUnitSource = "settings.num_images";
    } else {
      resolvedBillableUnits = 1;
      billableUnitSource = "fallback_unit";
    }
  }

  return buildCostResponse({
    costUsd: unitPriceUsd * resolvedBillableUnits,
    estimated,
    pricingSource: catalogModel?.pricingSource ?? "fal_platform_pricing",
    details: {
      type: "unit",
      unit,
      unitPriceUsd,
      billableUnits: resolvedBillableUnits,
      billableUnitSource
    }
  });
}
