import type { AddressInfo } from 'node:net';
import type { Writable } from 'node:stream';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyRequest, LogController } from 'fastify';
import { EN_TETE_COCKPIT } from '../../shared/cockpit.js';
import type { Appareil, RegistreAppareils } from './appareils.js';

// Chantier 31 (D171, D174) : le port des appareils. Une troisième instance Fastify, sur
// 127.0.0.1 seulement, que seul Tailscale Serve atteint. Elle n'enregistre que ses propres
// routes : ni le hook de security.ts, ni aucune route du port du Mac. Ce qui n'y est pas déclaré
// n'existe pas. Elle ne connaît que le cookie d'appareil : ni `Authorization`, ni le cookie
// `aid_session` n'y ouvrent rien.

export const COOKIE_APPAREIL = '__Host-aid_appareil';

declare module 'fastify' {
  interface FastifyRequest {
    appareil: Appareil | null;
  }
}

/** Les chemins d'appairage portent un id de demande : ils ne finissent pas dans daemon.log. */
export function masquerAppairage(url: string | undefined): string {
  return (url ?? '').replace(/\/appairage\/[^/?#]+/g, '/appairage/***').replace(/[?#].*$/, '');
}

export function cspAppareils(nom: string): string {
  return [
    "default-src 'self'",
    `connect-src 'self' wss://${nom}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export type ServeurAppareils =
  | { disponible: true; port: number; app: FastifyInstance }
  | { disponible: false; port: number; raison: string };

export interface OptionsServeurAppareils {
  /** 0 = un port libre au hasard (tests) */
  port: number;
  /** le port du daemon, le pont de l'app et le port des artefacts (D171) */
  interdits: Array<{ port: number; nom: string }>;
  /** le nom `.ts.net` du Mac (D173), lu à l'activation ; null = tout est refusé (421) */
  nom: () => string | null;
  registre: RegistreAppareils;
  /** le build de l'interface ; null hors build (tests, dev) */
  webRoot: string | null;
  logger?: boolean;
  /** tests : le journal va dans ce flux, pour vérifier ce qu'il ne contient pas */
  logStream?: Writable;
}

function chemin(req: FastifyRequest): string {
  return req.url.split(/[?#]/)[0] ?? '';
}

export async function ouvrirServeurAppareils(
  opts: OptionsServeurAppareils,
): Promise<ServeurAppareils> {
  const interdit = opts.port === 0 ? undefined : opts.interdits.find((i) => i.port === opts.port);
  if (interdit) {
    return {
      disponible: false,
      port: opts.port,
      raison: `le port ${opts.port} est réservé (${interdit.nom})`,
    };
  }
  const app = Fastify({
    // la méthode, le chemin (sans requête, demande masquée) et l'hôte : aucun en-tête, donc ni
    // cookie ni code d'appairage
    logger:
      opts.logger || opts.logStream
        ? {
            serializers: {
              req: (r) => ({
                method: r.method,
                url: masquerAppairage(r.url),
                host: r.headers?.host,
              }),
            },
            ...(opts.logStream && { stream: opts.logStream }),
          }
        : false,
    logController: new LogController({ disableRequestLogging: true }),
  });
  await app.register(fastifyCookie);
  app.decorateRequest('appareil', null);

  app.addHook('onRequest', async (req, reply) => {
    const nom = opts.nom();
    // 421 hors du nom `.ts.net` : ni 127.0.0.1, ni localhost, ni le nom avec un autre port
    if (nom === null || req.headers.host !== nom) {
      return reply.code(421).type('text/plain; charset=utf-8').send('hôte refusé');
    }
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `https://${nom}`) {
      return reply.code(403).send({ error: 'origine refusée' });
    }
    const p = chemin(req);
    const api = p.startsWith('/api/');
    const socket = p.startsWith('/ws/');
    // les fichiers de l'interface sont publics : ils ne portent rien du Mac (31.5, lab DM 91366)
    if (!api && !socket) return;
    const lu = opts.registre.authentifier(req.cookies[COOKIE_APPAREIL]);
    if (!lu.ok) {
      return reply.code(401).send({ error: 'Non authentifié', raison: lu.raison });
    }
    req.appareil = lu.appareil;
    // D165, repris pour le cookie d'appareil
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin') {
      return reply.code(403).send({ error: 'requête inter-site' });
    }
    if (socket && origin === undefined) return reply.code(403).send({ error: 'origine absente' });
    if (api && site === undefined && req.headers[EN_TETE_COCKPIT] !== '1') {
      return reply.code(403).send({ error: 'requête sans provenance' });
    }
  });
  app.addHook('onSend', async (req, reply) => {
    const nom = opts.nom();
    if (nom !== null) reply.header('Content-Security-Policy', cspAppareils(nom));
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    if (chemin(req).startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    // aucun cookie posé ici : seul l'appairage (31.6, D176) en posera
    reply.removeHeader('Set-Cookie');
  });
  app.addHook('onResponse', async (req, reply) => {
    if (reply.statusCode >= 400) req.log.warn({ req, statusCode: reply.statusCode }, 'refus');
  });

  // D174, D180 : qui suis-je. Le mode appareil de l'interface part de cette réponse.
  app.get('/api/appareils/moi', async (req) => {
    const a = req.appareil!;
    return { id: a.id, nom: a.nom, expireA: a.expireA };
  });

  if (opts.webRoot) {
    await app.register(fastifyStatic, { root: opts.webRoot });
  }
  app.setNotFoundHandler(async (req, reply) => {
    const p = chemin(req);
    const api = p.startsWith('/api/') || p.startsWith('/ws/');
    // le repli de la SPA : le même index.html, à l'octet près
    if (opts.webRoot && req.method === 'GET' && !api) return reply.sendFile('index.html');
    return reply.code(404).send({ error: 'introuvable' });
  });

  try {
    await app.listen({ host: '127.0.0.1', port: opts.port });
  } catch (err) {
    await app.close();
    const code = (err as NodeJS.ErrnoException).code;
    return {
      disponible: false,
      port: opts.port,
      raison: code === 'EADDRINUSE' ? `le port ${opts.port} est occupé` : String(err),
    };
  }
  return { disponible: true, port: (app.server.address() as AddressInfo).port, app };
}
