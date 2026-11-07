import type { AddressInfo } from 'node:net';
import type { Writable } from 'node:stream';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  LogController,
} from 'fastify';
import { EN_TETE_COCKPIT } from '../../shared/cockpit.js';
import type { StateSnapshot } from '../../shared/state.js';
import { type BoardReader, isBoardId } from '../mesh/board.js';
import { etatPourAppareil } from './masque.js';
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
const ROUTES_COOKIE = new Set([
  '/appairage/reclamer',
  '/appairage/:demandeId',
  '/api/appareils/moi/deconnexion',
]);
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
  /** D175 : l'état complet, que masque.ts réduit ; absent = 404 (tests du port seul) */
  etat?: () => Promise<StateSnapshot>;
  /** D175 : la source des signaux, le store d'événements */
  signal?: {
    on(e: 'event' | 'ephemeral', f: () => void): unknown;
    off(e: 'event' | 'ephemeral', f: () => void): unknown;
  };
  /** D178 : le lecteur du board des appareils, cache de 60 s ; null = mesh désactivé */
  board?: BoardReader | null;
  /** tests : l'horloge de l'échéance des sockets */
  now?: () => number;
  /** D174, tests : chaque route déclarée sur ce port */
  onRoute?: (r: { method: string | string[]; url: string }) => void;
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
  if (opts.onRoute) {
    const f = opts.onRoute;
    app.addHook('onRoute', (r) => f({ method: r.method, url: r.url }));
  }
  await app.register(fastifyCookie);
  await app.register(fastifyWebsocket);
  app.decorateRequest('appareil', null);
  const now = opts.now ?? (() => Date.now());

  // D177, D183 : les sockets de chaque appareil, fermées en 4401 à la révocation et à l'échéance
  const sockets = new Map<string, Set<WebSocket>>();
  const fermer = (id: string, raison: 'revoque' | 'expire') => {
    for (const s of sockets.get(id) ?? []) s.close(4401, raison);
  };
  const desabonner = opts.registre.surRevocation((ids) =>
    ids.forEach((id) => fermer(id, 'revoque')),
  );
  app.addHook('onClose', async () => {
    desabonner();
  });

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
    // une socket, ou une écriture (révoquer, se déconnecter) : l'Origin est exigée, comme au Mac
    if ((socket || req.method !== 'GET') && origin === undefined) {
      return reply.code(403).send({ error: 'origine absente' });
    }
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

  // D177 : les appareils connectés, vus d'un appareil. Ni l'identité, ni l'empreinte.
  app.get('/api/appareils', async (req) =>
    opts.registre.lister().map((a) => ({
      id: a.id,
      nom: a.nom,
      creeA: a.creeA,
      dernierContact: a.dernierContact,
      expireA: a.expireA,
      etat: a.etat,
      moi: a.id === req.appareil!.id,
    })),
  );
  // D177 : révoquer depuis un appareil, sans confirmation (règles globales), soi compris
  app.delete('/api/appareils/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!opts.registre.revoquer(id))
      return reply.code(404).send({ error: 'appareil inconnu ou déjà coupé' });
    return { ok: true };
  });
  app.post('/api/appareils/moi/deconnexion', async (req, reply) => {
    opts.registre.revoquer(req.appareil!.id);
    reply.clearCookie(COOKIE_APPAREIL, COOKIE);
    return { ok: true };
  });

  // D175 : l'état masqué, champ par champ
  app.get('/api/state', async (_req, reply) => {
    if (!opts.etat) return reply.code(404).send({ error: 'introuvable' });
    return etatPourAppareil(await opts.etat());
  });

  // D175, D183 : un signal sans contenu ; l'appareil relit GET /api/state
  app.get('/ws/signal', { websocket: true }, (socket, req) => {
    const a = req.appareil!;
    const liste = sockets.get(a.id) ?? new Set<WebSocket>();
    liste.add(socket);
    sockets.set(a.id, liste);
    const echeance = setTimeout(
      () => socket.close(4401, 'expire'),
      Math.max(0, Date.parse(a.expireA) - now()),
    );
    let attente: NodeJS.Timeout | null = null;
    const changer = () => {
      // anti-rebond de 250 ms : une rafale d'événements fait un seul signal
      attente ??= setTimeout(() => {
        attente = null;
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ kind: 'changed' }));
      }, 250);
    };
    opts.signal?.on('event', changer);
    opts.signal?.on('ephemeral', changer);
    socket.on('close', () => {
      clearTimeout(echeance);
      if (attente) clearTimeout(attente);
      opts.signal?.off('event', changer);
      opts.signal?.off('ephemeral', changer);
      liste.delete(socket);
      if (liste.size === 0) sockets.delete(a.id);
    });
  });

  // D178 : le board, par le lecteur des appareils (60 s). `?fresh=1` est ignoré.
  const board = (reply: FastifyReply) => {
    if (opts.board) return opts.board;
    void reply.code(404).send({ error: 'mesh désactivé' });
    return null;
  };
  const id = (raw: string) => (/^\d+$/.test(raw) && isBoardId(Number(raw)) ? Number(raw) : null);
  app.get('/api/board/projects', async (_req, reply) => board(reply)?.projects() ?? reply);
  app.get('/api/board/projects/:projectId/cards', async (req, reply) => {
    const n = id((req.params as { projectId: string }).projectId);
    if (n === null) return reply.code(400).send({ error: 'identifiant invalide' });
    return board(reply)?.cards(n) ?? reply;
  });
  app.get('/api/board/cards/:cardId', async (req, reply) => {
    const n = id((req.params as { cardId: string }).cardId);
    if (n === null) return reply.code(400).send({ error: 'identifiant invalide' });
    return board(reply)?.card(n) ?? reply;
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
