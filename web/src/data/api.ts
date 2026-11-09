import { EN_TETE_COCKPIT } from '../../../src/shared/cockpit.js';
import { effacer } from './dernierEtat.js';

export class SessionExpired extends Error {
  /** chantier 31 (D177) : sur le port des appareils, `inconnu`, `expire` ou `revoque` */
  constructor(readonly raison: string | null = null) {
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
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  fetchImpl: typeof fetch = fetch,
  headers?: Record<string, string>,
): Promise<T> {
  const res = await fetchImpl(path, {
    method,
    credentials: 'same-origin',
    // chantier 30 (D165) : la marque du cockpit, qu'une navigation ne peut pas imiter
    headers: {
      [EN_TETE_COCKPIT]: '1',
      ...headers,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    // corps non JSON : on garde le texte comme message
  }
  // le port du Mac répond en texte ; celui des appareils dit pourquoi (D177)
  if (res.status === 401) {
    void effacer();
    throw new SessionExpired(typeof json.raison === 'string' ? json.raison : null);
  }
  if (!res.ok) {
    throw new AidApiError(
      res.status,
      json.error === 'confirmation_impossible' && typeof json.message === 'string'
        ? json.message
        : typeof json.error === 'string'
          ? json.error
          : text || res.statusText,
      json,
    );
  }
  return json as T;
}
