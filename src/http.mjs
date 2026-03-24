export function json(data, init = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(init.headers ?? {})
    },
    status: init.status ?? 200
  });
}

export function error(message, status = 400, details) {
  return json(
    {
      error: message,
      details: details ?? null
    },
    { status }
  );
}

export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export function bearerToken(request) {
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) {
    return null;
  }
  return header.slice("Bearer ".length);
}
