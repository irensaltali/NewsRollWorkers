// Structured logging for Cloudflare Workers observability.
// Cloudflare captures console output automatically and tags by level.
// All methods accept a plain object — keep fields flat for easy filtering.

function defaultMessage(level, fields) {
  if (fields?.event === "request") {
    const method = fields.method ?? "REQUEST";
    const path = fields.path ?? "";
    const status = fields.status ?? "pending";
    const route = fields.route ? ` [${fields.route}]` : "";
    return `${method} ${path} -> ${status}${route}`;
  }

  if (fields?.event === "request_error") {
    const method = fields.method ?? "REQUEST";
    const path = fields.path ?? "";
    const error = fields.error ? `: ${fields.error}` : "";
    return `${method} ${path} failed${error}`;
  }

  if (typeof fields?.event === "string") {
    return fields.error ? `${fields.event}: ${fields.error}` : fields.event;
  }

  if (typeof fields?.error === "string") {
    return fields.error;
  }

  return `${level}_log`;
}

function emit(writer, level, fields = {}) {
  const payload = {
    ...fields,
    message: typeof fields?.message === "string" && fields.message.trim()
      ? fields.message
      : defaultMessage(level, fields)
  };
  writer(JSON.stringify(payload));
}

export function debug(fields) { emit(console.debug, "debug", fields); }
export function info(fields) { emit(console.log, "info", fields); }
export function warn(fields) { emit(console.warn, "warn", fields); }
export function error(fields) { emit(console.error, "error", fields); }

/**
 * Extract a short correlation ID from the request.
 * Uses Cloudflare's Ray ID when available, falls back to a random suffix.
 */
export function requestId(request) {
  return request?.headers?.get("cf-ray")?.split("-")[0] ?? crypto.randomUUID().slice(0, 8);
}

/**
 * Extract useful request metadata for logging.
 */
export function requestMeta(request) {
  const url = new URL(request.url);
  const meta = {
    method: request.method,
    path: url.pathname,
    userAgent: request.headers.get("user-agent") ?? undefined,
    contentType: request.headers.get("content-type") ?? undefined,
    cfCountry: request.headers.get("cf-ipcountry") ?? undefined,
  };
  const qs = url.search;
  if (qs) meta.query = qs;
  return meta;
}

/**
 * Format an error for structured logging.
 * Keeps message + first 5 stack frames, drops everything else.
 */
export function fmtError(err) {
  if (!(err instanceof Error)) {
    return { error: String(err) };
  }
  return {
    error: err.message,
    stack: err.stack
      ?.split("\n")
      .slice(1, 6)
      .map((l) => l.trim())
      .join(" <- ")
  };
}
