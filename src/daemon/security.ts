import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';

export const SESSION_COOKIE = 'aid_session';
// 400 jours : le plafond que Chrome applique de toute façon à un cookie persistant
export const SESSION_MAX_AGE_S = 400 * 24 * 3600;

export interface AuthState {
  adminToken: string;
  // distinct du jeton admin et gardé d'un démarrage à l'autre : une app épinglée au Dock
  // reste connectée après un redémarrage du daemon ; le jeton admin, lui, change toujours
  sessionToken: string;
  runTokens: Map<string, string>;
}

export type Principal =
  { kind: 'admin'; via: 'cookie' | 'bearer' } | { kind: 'run'; runId: string };

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
  }
}

export function createAuthState(sessionToken = randomBytes(32).toString('base64url')): AuthState {
  return { adminToken: randomBytes(32).toString('base64url'), sessionToken, runTokens: new Map() };
}

export function writeSessionToken(file: string): string {
  const token = randomBytes(32).toString('base64url');
  writeFileSync(file, token, { mode: 0o600 });
  // le mode de writeFileSync ne s'applique qu'à la création
  chmodSync(file, 0o600);
  return token;
}

export function loadSessionToken(file: string): string {
  try {
    const token = readFileSync(file, 'utf8').trim();
    if (token.length >= 32) return token;
  } catch {
    // absent : premier démarrage, ou secret révoqué par aid open --reset
  }
  return writeSessionToken(file);
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
  if (cookie && safeEqual(cookie, auth.sessionToken)) return { kind: 'admin', via: 'cookie' };
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
        .setCookie(SESSION_COOKIE, auth.sessionToken, {
          httpOnly: true,
          sameSite: 'strict',
          path: '/',
          maxAge: SESSION_MAX_AGE_S,
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
    // http://127.0.0.1:4871 : pont de redémarrage de l'app native Tauri (app/src-tauri/src/daemon_bridge.rs,
    // RESTART_BRIDGE_PORT), appelé en fetch() par le CTA de la coquille hors-ligne
    // (web/src/ecrans/Accueil.tsx) — sans cette entrée, connect-src 'self' bloque cette requête
    // cross-origin avant même qu'elle parte, et le CTA échoue silencieusement.
    reply.header(
      'Content-Security-Policy',
      `default-src 'self'; connect-src 'self' ws://127.0.0.1:${port} ws://localhost:${port} http://127.0.0.1:4871; ` +
        "style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'",
    );
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
  });
}
