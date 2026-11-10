import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';

/** D263 : 15 s visées en amont + 5 s ; à recaler sur le document de schéma du proxy. */
export const DELAI_PROXY_MS = 20_000;
export const VERBES_PROXY = [
  'board.cards.say',
  'mesh.send',
  'channel.post',
  'board.obligations.take',
  'board.obligations.decline',
  'board.obligations.close',
] as const;
export const VERBES_LECTURE = [
  'board.projects.list',
  'board.cards.list',
  'board.card.get',
  'board.cards.graph',
  'board.cards.thread',
  'board.obligations.list',
  'mesh.peers',
  'rights',
  'memory.list',
  'memory.get',
] as const;
const CODES_PROXY = [
  'verb_not_allowed',
  'bad_args',
  'peer_not_allowed',
  'proxy_unavailable',
  'upstream_unreachable',
  'upstream_ambiguous',
  'upstream_error',
] as const;
const MAX_LIGNE = 1024 * 1024;

type CodeProxy = (typeof CODES_PROXY)[number] | 'delai' | 'interrompu' | 'connexion' | 'format';
type CorpsProxy = Record<string, unknown> | unknown[];
export type ResultatProxy<Corps = CorpsProxy> =
  { ok: true; status: number; body: Corps } | { ok: false; code: CodeProxy; status?: number };

function estObjet(valeur: unknown): valeur is Record<string, unknown> {
  return typeof valeur === 'object' && valeur !== null && !Array.isArray(valeur);
}

/** Ne conserve jamais le détail du proxy, même dans les réponses valides. */
export function lireReponseProxy(
  ligne: string,
  requestId: string,
  verbes?: typeof VERBES_PROXY,
): ResultatProxy<Record<string, unknown>>;
export function lireReponseProxy(
  ligne: string,
  requestId: string,
  verbes: typeof VERBES_PROXY | typeof VERBES_LECTURE,
): ResultatProxy;
export function lireReponseProxy(
  ligne: string,
  requestId: string,
  verbes: typeof VERBES_PROXY | typeof VERBES_LECTURE = VERBES_PROXY,
): ResultatProxy {
  const format = { ok: false, code: 'format' } as const;
  let reponse: unknown;
  try {
    reponse = JSON.parse(ligne);
  } catch {
    return format;
  }
  if (!estObjet(reponse) || reponse.request_id !== requestId) return format;
  if (reponse.ok === true) {
    if (
      typeof reponse.status !== 'number' ||
      !Number.isInteger(reponse.status) ||
      reponse.status < 200 ||
      reponse.status >= 300 ||
      !(estObjet(reponse.body) || (verbes[0] === VERBES_LECTURE[0] && Array.isArray(reponse.body)))
    )
      return format;
    return { ok: true, status: reponse.status, body: reponse.body };
  }
  if (reponse.ok === false) {
    const code = CODES_PROXY.find((code) => code === reponse.error);
    if (code)
      return {
        ok: false,
        code,
        ...(typeof reponse.status === 'number' &&
          Number.isInteger(reponse.status) &&
          reponse.status >= 100 &&
          reponse.status <= 599 && { status: reponse.status }),
      };
  }
  return format;
}

/** Schéma publié, section « Argument types » et table des verbes de lecture. */
export function argumentsLectureValides(verbe: string, args: Record<string, unknown>): boolean {
  const champs: Record<string, string[]> = {
    'board.projects.list': [],
    'board.cards.list': ['project', 'stage', 'assignee', 'label', 'q'],
    'board.card.get': ['id'],
    'board.cards.graph': ['id'],
    'board.cards.thread': ['id', 'limit'],
    'board.obligations.list': [
      'id',
      'card_id',
      'status',
      'holder',
      'created_by',
      'limit',
      'overdue',
      'grandfathered',
    ],
    'mesh.peers': ['enabled_only'],
    rights: [],
    'memory.get': ['slug'],
    'memory.list': ['type', 'tag', 'limit'],
  };
  const autorises = champs[verbe];
  if (!autorises || Object.keys(args).some((cle) => !autorises.includes(cle))) return false;
  if (
    ['board.card.get', 'board.cards.graph', 'board.cards.thread'].includes(verbe) &&
    !('id' in args)
  )
    return false;
  if (verbe === 'memory.get' && !('slug' in args)) return false;
  return Object.entries(args).every(([cle, valeur]) => {
    if (['id', 'card_id', 'project', 'limit'].includes(cle))
      return (
        typeof valeur === 'number' &&
        Number.isSafeInteger(valeur) &&
        valeur > 0 &&
        (cle !== 'limit' || valeur <= 1000)
      );
    if (['overdue', 'grandfathered', 'enabled_only'].includes(cle))
      return typeof valeur === 'boolean';
    if (cle === 'q') return typeof valeur === 'string' && valeur.length <= 1000;
    if (cle === 'slug')
      return typeof valeur === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(valeur);
    return typeof valeur === 'string';
  });
}

interface OptionsProxy {
  socket: string;
  delaiMs?: number;
  uuid?: () => string;
}
interface ClientProxy<Corps = CorpsProxy> {
  appeler(verbe: string, args: Record<string, unknown>): Promise<ResultatProxy<Corps>>;
}

export function creerProxyClient(
  options: OptionsProxy & { verbes?: typeof VERBES_PROXY },
): ClientProxy<Record<string, unknown>>;
export function creerProxyClient(
  options: OptionsProxy & { verbes: typeof VERBES_LECTURE },
): ClientProxy;
export function creerProxyClient(
  options: OptionsProxy & { verbes?: typeof VERBES_PROXY | typeof VERBES_LECTURE },
): ClientProxy {
  return {
    appeler(verbe: string, args: Record<string, unknown>): Promise<ResultatProxy> {
      if (!(options.verbes ?? VERBES_PROXY).some((autorise) => autorise === verbe))
        throw new Error('Verbe proxy non autorisé');
      if (
        VERBES_LECTURE.some((lecture) => lecture === verbe) &&
        !argumentsLectureValides(verbe, args)
      )
        return Promise.resolve({ ok: false, code: 'bad_args' });
      const requestId = (options.uuid ?? randomUUID)();
      const ligne = JSON.stringify({ verb: verbe, args, request_id: requestId }) + '\n';
      if (!options.socket) return Promise.resolve({ ok: false, code: 'connexion' });
      return new Promise((resolve) => {
        const connexion = createConnection({ path: options.socket });
        const morceaux: Buffer[] = [];
        let taille = 0;
        let termine = false;
        let ligneEcrite = false;
        const finir = (resultat: ResultatProxy) => {
          if (termine) return;
          termine = true;
          clearTimeout(minuteur);
          connexion.destroy();
          resolve(resultat);
        };
        const minuteur = setTimeout(
          () => finir({ ok: false, code: 'delai' }),
          options.delaiMs ?? DELAI_PROXY_MS,
        );
        const interrompre = () =>
          finir({ ok: false, code: ligneEcrite ? 'interrompu' : 'connexion' });
        connexion.on('error', interrompre);
        connexion.on('close', interrompre);
        connexion.on('connect', () => {
          // Dès write : une erreur avant son rappel ne garantit pas que rien n'est parti.
          ligneEcrite = true;
          connexion.write(ligne);
        });
        connexion.on('data', (morceau: Buffer) => {
          const fin = morceau.indexOf(10);
          const contenu = fin < 0 ? morceau : morceau.subarray(0, fin);
          taille += contenu.length;
          if (taille > MAX_LIGNE) {
            finir({ ok: false, code: 'format' });
            return;
          }
          morceaux.push(contenu);
          if (fin >= 0)
            finir(
              lireReponseProxy(
                Buffer.concat(morceaux).toString('utf8'),
                requestId,
                options.verbes ?? VERBES_PROXY,
              ),
            );
        });
      });
    },
  };
}
