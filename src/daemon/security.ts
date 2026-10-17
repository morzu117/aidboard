import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';

export const SESSION_COOKIE = 'aid_session';

export interface AuthState {
  adminToken: string;
  runTokens: Map<string, string>;
}

export type Principal =
  { kind: 'admin'; via: 'cookie' | 'bearer' } | { kind: 'run'; runId: string };

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
  }
}

export function createAuthState(): AuthState {
  return { adminToken: randomBytes(32).toString('base64url'), runTokens: new Map() };
}

export function issueRunToken(auth: AuthState, runId: string): string {
  for (const [token, id] of auth.runTokens) if (id === runId) return token;
  const token = randomBytes(24).toString('base64url');
  auth.runTokens.set(token, runId);
  return token;
}

export function revokeRunTokens(auth: AuthState, runId: string): void {
  for (const [token, id] of auth.runTokens) if (id === runId) auth.runTokens.delete(token);
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7) : null;
}

function authenticate(req: FastifyRequest, auth: AuthState): Principal | null {
  const cookie = req.cookies[SESSION_COOKIE];
  if (cookie && safeEqual(cookie, auth.adminToken)) return { kind: 'admin', via: 'cookie' };
  const token = bearer(req);
  if (!token) return null;
  if (safeEqual(token, auth.adminToken)) return { kind: 'admin', via: 'bearer' };
  const runId = auth.runTokens.get(token);
  return runId ? { kind: 'run', runId } : null;
}

export interface SecurityOptions {
  getPort: () => number;
  devOrigin?: string;
}

export function registerSecurity(
  app: FastifyInstance,
  auth: AuthState,
  opts: SecurityOptions,
): void {
  app.decorateRequest('principal', null);

  const hosts = () => [`127.0.0.1:${opts.getPort()}`, `localhost:${opts.getPort()}`];
  const origins = () => [
    ...hosts().map((h) => `http://${h}`),
    ...(opts.devOrigin ? [opts.devOrigin] : []),
  ];

  app.addHook('onRequest', async (req, reply) => {
    if (!req.headers.host || !hosts().includes(req.headers.host)) {
      return reply.code(421).send({ error: 'hôte refusé' });
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !origins().includes(origin)) {
      return reply.code(403).send({ error: 'origine refusée' });
    }

    const path = req.url.split('?')[0] ?? '';
    const query = req.query as { token?: unknown };
    // la spec ouvre le navigateur sur /?token=… ; /auth?token=… reste accepté
    if (req.method === 'GET' && (path === '/auth' || (path === '/' && query.token !== undefined))) {
      const token = query.token;
      if (typeof token !== 'string' || !safeEqual(token, auth.adminToken)) {
        return reply
          .code(401)
          .type('text/plain; charset=utf-8')
          .send('Lien expiré : relancer `aid open`');
      }
      return reply
        .setCookie(SESSION_COOKIE, auth.adminToken, {
          httpOnly: true,
          sameSite: 'strict',
          path: '/',
        })
        .redirect('/', 303);
    }

    const principal = authenticate(req, auth);
    if (!principal) {
      return reply.code(401).type('text/plain; charset=utf-8').send('Non authentifié');
    }
    req.principal = principal;

    const memoryApi = path.startsWith('/api/memory/');
    const structuralApi = path.startsWith('/api/structural/');
    if (
      principal.kind === 'run' &&
      !memoryApi &&
      !structuralApi &&
      !(req.method === 'POST' && path === '/api/events')
    ) {
      return reply.code(403).send({ error: 'token de run : POST /api/events uniquement' });
    }
    const isSocket = path.startsWith('/ws/');
    if (principal.kind === 'admin' && principal.via === 'cookie') {
      if ((req.method !== 'GET' || isSocket) && origin === undefined) {
        return reply.code(403).send({ error: 'origine absente' });
      }
    }
  });

  app.addHook('preHandler', async (req, reply) => {
    const p = req.principal;
    if (p?.kind !== 'run') return;
    const runId = (req.body as { runId?: unknown } | null)?.runId;
    if (runId !== undefined && runId !== p.runId) {
      return reply.code(403).send({ error: 'runId étranger' });
    }
  });

  app.addHook('onSend', async (_req, reply) => {
    const port = opts.getPort();
    reply.header(
      'Content-Security-Policy',
      `default-src 'self'; connect-src 'self' ws://127.0.0.1:${port} ws://localhost:${port}; ` +
        "style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'",
    );
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
  });
}
