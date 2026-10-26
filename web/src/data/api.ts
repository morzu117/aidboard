export class SessionExpired extends Error {
  constructor() {
    super('session expirée');
  }
}

export class AidApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export async function api<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const res = await fetchImpl(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) throw new SessionExpired();
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    // corps non JSON : on garde le texte comme message
  }
  if (!res.ok) {
    throw new AidApiError(
      res.status,
      typeof json.error === 'string' ? json.error : text || res.statusText,
      json,
    );
  }
  return json as T;
}
