import type { AddressInfo } from 'node:net';
import type { Writable } from 'node:stream';
import Fastify, { type FastifyInstance, LogController } from 'fastify';
import type { JetonsArtefacts, TypeArtefact } from './jetons.js';

// Chantier 30 (D162, D164) : le second port d'écoute du daemon, réservé aux artefacts. Une
// autre origine que le cockpit : il n'a aucune route de l'API, ne lit jamais le cookie de
// session (que le navigateur lui envoie quand même, un cookie ignore le port) et ne sert
// qu'un contenu désigné par un jeton (jetons.ts).

/** Port du pont de redémarrage Tauri (security.ts) : jamais celui des artefacts. */
export const PORT_PONT_TAURI = 4871;

const TYPES: Record<TypeArtefact, string> = {
  html: 'text/html; charset=utf-8',
  svg: 'image/svg+xml',
};

/** CSP de chaque réponse : `sandbox` donne une origine opaque, même hors de l'iframe. */
export function cspArtefact(portDaemon: number, portArtefacts?: number): string {
  return [
    'sandbox allow-scripts',
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'font-src data:',
    'media-src data: blob:',
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    `frame-ancestors http://127.0.0.1:${portDaemon} http://localhost:${portDaemon}${
      // 30.9 (lab, DM 91283) : l'enveloppe de « Ouvrir à part », servie par ce port, l'encadre aussi
      portArtefacts === undefined
        ? ''
        : ` http://127.0.0.1:${portArtefacts} http://localhost:${portArtefacts}`
    }`,
  ].join('; ');
}

/**
 * 30.9 (lab, DM 91283) : la CSP de l'enveloppe. Elle n'a aucun script (default-src 'none') et
 * n'encadre que ce port : l'artefact y est de nouveau un cadre, sous le même frame-src que dans le
 * cockpit. Pas de `sandbox` ici : une origine opaque ne satisferait pas le frame-ancestors de
 * l'artefact. Sans script, l'enveloppe ne fait rien de son origine.
 */
export const CSP_ENVELOPPE = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "frame-src 'self'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** La page enveloppe : le cadre sandboxé seul. Le jeton est valide, donc aléatoire, jamais une donnée. */
export function pageEnveloppe(jeton: string): string {
  return [
    '<!doctype html>',
    '<html lang="fr"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer">',
    '<title>Artefact</title>',
    '<style>html,body{margin:0;height:100%}iframe{display:block;border:0;width:100%;height:100%}</style>',
    '</head><body>',
    `<iframe src="/a/${jeton}" sandbox="allow-scripts" referrerpolicy="no-referrer" title="Artefact"></iframe>`,
    '</body></html>',
  ].join('\n');
}

/** Le jeton ne doit pas finir dans daemon.log (même règle que `?token=`). */
export function masquerJeton(url: string | undefined): string {
  return (url ?? '').replace(/\/(a|v)\/[^/?#]*/g, '/$1/***');
}

export type ServeurArtefacts =
  | { disponible: true; port: number; app: FastifyInstance }
  | { disponible: false; port: number; raison: string };

export interface OptionsServeurArtefacts {
  /** 0 = un port libre au hasard (tests) */
  port: number;
  portDaemon: () => number;
  jetons: JetonsArtefacts;
  logger?: boolean;
  /** tests : le journal va dans ce flux, pour vérifier ce qu'il ne contient pas */
  logStream?: Writable;
}

export async function ouvrirServeurArtefacts(
  opts: OptionsServeurArtefacts,
): Promise<ServeurArtefacts> {
  const daemon = opts.portDaemon();
  if (opts.port !== 0 && (opts.port === daemon || opts.port === PORT_PONT_TAURI)) {
    return {
      disponible: false,
      port: opts.port,
      raison: `le port ${opts.port} est réservé (${opts.port === daemon ? 'daemon' : 'pont Tauri'})`,
    };
  }
  const app = Fastify({
    // seuls la méthode, le chemin (jeton masqué) et l'hôte : aucun en-tête, donc ni le cookie
    // que le navigateur envoie à ce port, ni rien d'autre
    logger:
      opts.logger || opts.logStream
        ? {
            serializers: {
              req: (r) => ({ method: r.method, url: masquerJeton(r.url), host: r.headers?.host }),
            },
            ...(opts.logStream && { stream: opts.logStream }),
          }
        : false,
    logController: new LogController({ disableRequestLogging: true }),
  });
  const port = () => (app.server.address() as AddressInfo | null)?.port ?? opts.port;

  app.addHook('onRequest', async (req, reply) => {
    // 421 sur tout autre hôte : c'est aussi la défense contre le DNS rebinding (un nom
    // étranger résolu vers 127.0.0.1 garde son Host)
    const hosts = [`127.0.0.1:${port()}`, `localhost:${port()}`];
    if (!req.headers.host || !hosts.includes(req.headers.host)) {
      return reply.code(421).type('text/plain; charset=utf-8').send('hôte refusé');
    }
  });
  app.addHook('onSend', async (req, reply) => {
    const enveloppe = req.routeOptions.url === '/v/:jeton' && reply.statusCode === 200;
    reply.header(
      'Content-Security-Policy',
      enveloppe ? CSP_ENVELOPPE : cspArtefact(opts.portDaemon(), port()),
    );
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cache-Control', 'no-store');
    reply.removeHeader('Set-Cookie');
  });
  app.addHook('onResponse', async (req, reply) => {
    if (reply.statusCode >= 400) req.log.warn({ req, statusCode: reply.statusCode }, 'refus');
  });

  app.get('/a/:jeton', async (req, reply) => {
    const { jeton } = req.params as { jeton: string };
    const c = opts.jetons.lire(jeton);
    // aucun corps qui répète le jeton
    if (!c) return reply.code(404).type('text/plain; charset=utf-8').send('Lien expiré ou inconnu');
    return reply.type(TYPES[c.type]).send(c.contenu);
  });
  // 30.9 : « Ouvrir à part » ouvre l'enveloppe, plus l'artefact seul en page de premier niveau
  app.get('/v/:jeton', async (req, reply) => {
    const { jeton } = req.params as { jeton: string };
    if (!opts.jetons.lire(jeton)) {
      return reply.code(404).type('text/plain; charset=utf-8').send('Lien expiré ou inconnu');
    }
    return reply.type('text/html; charset=utf-8').send(pageEnveloppe(jeton));
  });
  app.route({
    method: ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    url: '/v/:jeton',
    handler: async (_req, reply) => reply.code(405).send(),
  });
  app.route({
    method: ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    url: '/a/:jeton',
    handler: async (_req, reply) => reply.code(405).send(),
  });
  app.setNotFoundHandler(async (_req, reply) =>
    reply.code(404).type('text/plain; charset=utf-8').send('introuvable'),
  );

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
  return { disponible: true, port: port(), app };
}
