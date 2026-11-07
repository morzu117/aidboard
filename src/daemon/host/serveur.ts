import type { AddressInfo } from 'node:net';
import type { Writable } from 'node:stream';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyRequest, LogController } from 'fastify';
import { EN_TETE_COCKPIT } from '../../shared/cockpit.js';
import type { Appairages } from './appairage.js';
import { type Appareil, DUREE_ACCES_MS, nomAppareil, type RegistreAppareils } from './appareils.js';

// Chantier 31 (D171, D174) : le port des appareils. Une troisième instance Fastify, sur
// 127.0.0.1 seulement, que seul Tailscale Serve atteint. Elle n'enregistre que ses propres
// routes : ni le hook de security.ts, ni aucune route du port du Mac. Ce qui n'y est pas déclaré
// n'existe pas. Elle ne connaît que le cookie d'appareil : ni `Authorization`, ni le cookie
// `aid_session` n'y ouvrent rien.

export const COOKIE_APPAREIL = '__Host-aid_appareil';
/** D176 (lab, DM 91366) : lie l'appareil qui a réclamé à sa demande, 5 minutes */
export const COOKIE_DEMANDE = '__Host-aid_demande';
/** D176 : code faux, expiré, annulé ou déjà pris, demande inconnue ou sans son cookie : un seul corps */
export const CORPS_INCONNU = { error: 'Code inconnu, expiré ou déjà utilisé' };
/** les deux seules routes qui posent un cookie (D176) */
const ROUTES_COOKIE = new Set(['/appairage/reclamer', '/appairage/:demandeId']);
const COOKIE = { httpOnly: true, secure: true, sameSite: 'strict', path: '/' } as const;

// caractères de contrôle et de mise en forme : un login n'en a pas
// eslint-disable-next-line no-control-regex -- les refuser est le but
const CONTROLES = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/;

/**
 * D179 : l'identité que Tailscale Serve dit avoir vue. Tant que la mesure de 31.2 n'a pas
 * prouvé qu'un client ne peut pas l'imposer, elle n'est qu'affichée, « non vérifiable ».
 */
export function identiteTailscale(req: FastifyRequest): string | null {
  const v = req.headers['tailscale-user-login'];
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' || t.length > 256 || CONTROLES.test(t) ? null : t;
}

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
  appairages: Appairages;
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
    const p = chemin(req);
    if (p.startsWith('/api/') || p.startsWith('/appairage/')) {
      reply.header('Cache-Control', 'no-store');
    }
    // aucun cookie posé ici, hors des deux routes de l'appairage (D176)
    if (!ROUTES_COOKIE.has(req.routeOptions.url ?? '')) reply.removeHeader('Set-Cookie');
  });
  app.addHook('onResponse', async (req, reply) => {
    if (reply.statusCode >= 400) req.log.warn({ req, statusCode: reply.statusCode }, 'refus');
  });

  // D174, D180 : qui suis-je. Le mode appareil de l'interface part de cette réponse.
  app.get('/api/appareils/moi', async (req) => {
    const a = req.appareil!;
    return { id: a.id, nom: a.nom, expireA: a.expireA };
  });

  // D176 : la seule écriture sans authentification de ce port. L'Origin est exigée : seule la
  // page /appairer, servie par ce port, la fait.
  app.post('/appairage/reclamer', { bodyLimit: 4096 }, async (req, reply) => {
    const site = req.headers['sec-fetch-site'];
    if (req.headers.origin === undefined || (site !== undefined && site !== 'same-origin')) {
      return reply.code(403).send({ error: 'origine absente' });
    }
    const corps = (req.body ?? {}) as { code?: unknown; nom?: unknown };
    const r = opts.appairages.reclamer({
      code: corps.code,
      nom: nomAppareil(corps.nom),
      identite: identiteTailscale(req),
      // D179 : en attendant la mesure de 31.2, aucune adresse n'est crue : le plafond est global
      source: '',
    });
    if (!r.ok) {
      return r.raison === 'plafond'
        ? reply.code(429).send({ error: 'Trop d’essais : réessayer dans une minute' })
        : reply.code(404).send(CORPS_INCONNU);
    }
    reply.setCookie(COOKIE_DEMANDE, r.jetonDemande, { ...COOKIE, maxAge: 5 * 60 });
    return { demandeId: r.demandeId, codeCourt: r.codeCourt };
  });
  // D176 : l'appareil attend l'approbation. Il faut le chemin **et** le cookie de demande.
  app.get('/appairage/:demandeId', async (req, reply) => {
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin') {
      return reply.code(403).send({ error: 'requête inter-site' });
    }
    const { demandeId } = req.params as { demandeId: string };
    const lu = opts.appairages.lirePourAppareil(demandeId, req.cookies[COOKIE_DEMANDE]);
    if (lu.etat === 'inconnu') return reply.code(404).send(CORPS_INCONNU);
    if (lu.etat === 'attente') return { etat: 'attente' };
    if (lu.etat === 'consommee') return { etat: 'consomme' };
    const { jeton } = opts.registre.emettre({ nom: lu.nom, identite: lu.identite });
    reply.clearCookie(COOKIE_DEMANDE, COOKIE);
    reply.setCookie(COOKIE_APPAREIL, jeton, { ...COOKIE, maxAge: DUREE_ACCES_MS / 1000 });
    return { etat: 'approuve' };
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
