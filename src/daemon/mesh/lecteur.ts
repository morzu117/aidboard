import type { BoardErrorKind } from '../../shared/board.js';
import type { MeshExecResult } from './exec.js';
import { creerProxyClient, VERBES_LECTURE, type ResultatProxy } from './proxy.js';

export type ResultatLecture = MeshExecResult & { kind?: BoardErrorKind };
export interface Lecteur {
  lire(
    args: string[],
    options?: { env?: Record<string, string>; unset?: string[] },
  ): Promise<ResultatLecture>;
}

/** D280 : aucun texte distant ne participe au classement ni au journal. */
export function classerErreurProxy(resultat: ResultatProxy): BoardErrorKind | null {
  if (resultat.ok) return null;
  switch (resultat.code) {
    case 'proxy_unavailable':
    case 'connexion':
    case 'upstream_unreachable':
    case 'upstream_ambiguous':
    case 'interrompu':
      return 'unreachable';
    case 'delai':
      return 'timeout';
    case 'format':
      return 'format';
    case 'upstream_error':
      switch (resultat.status) {
        case 401:
          return 'credential';
        case 403:
          return 'forbidden';
        case 404:
          return 'not-found';
        default:
          return 'unknown';
      }
    default:
      return 'unknown';
  }
}

/** Le CLI conserve exactement ses argv et son environnement. */
export function creerLecteurCli(mesh: { read: Lecteur['lire'] }): Lecteur {
  return { lire: (args, options) => mesh.read(args, options) };
}

/** Seules les commandes fermées des deux readers sont traduites. */
export function creerLecteurProxy(socket: string): Lecteur {
  const client = creerProxyClient({ socket, verbes: VERBES_LECTURE });
  return {
    async lire(argv) {
      let verb: (typeof VERBES_LECTURE)[number];
      const args: Record<string, unknown> = {};
      if (argv[0] === 'board') {
        if (argv[1] === 'projects') verb = 'board.projects.list';
        else if (argv[1] === 'obligations') {
          verb = 'board.obligations.list';
          args.card_id = Number(argv[4]);
        } else if (argv[2] === 'list') {
          verb = 'board.cards.list';
          if (argv[3] === '--search') args.q = argv[4];
          else args.project = Number(argv[4]);
        } else {
          verb =
            argv[2] === 'show'
              ? 'board.card.get'
              : argv[2] === 'graph'
                ? 'board.cards.graph'
                : 'board.cards.thread';
          args.id = Number(argv[3]);
          if (verb === 'board.cards.thread') args.limit = Number(argv[5]);
        }
      } else if (argv[0] === 'mesh') verb = 'mesh.peers';
      else if (argv[0] === 'rights') verb = 'rights';
      else if (argv[0] === 'memory' && argv[1] === 'list') {
        verb = 'memory.list';
        args.limit = 100;
        if (argv[2] === '--tag') args.tag = argv[3];
        if (argv[2] === '--type') args.type = argv[3];
      } else if (argv[0] === 'memory' && argv[1] === 'get') {
        verb = 'memory.get';
        args.slug = argv[2];
      } else if (argv[0] === 'memory' && argv[1] === 'links') {
        return { ok: false, timedOut: false, stdout: '', stderr: '', kind: 'proxy-indisponible' };
      } else return { ok: false, timedOut: false, stdout: '', stderr: '', kind: 'not-configured' };
      // Les nombres proviennent uniquement des identifiants déjà validés par BoardReader.
      const resultat = await client.appeler(verb, args);
      const kind = classerErreurProxy(resultat);
      return {
        ok: resultat.ok,
        timedOut: false,
        stdout: resultat.ok ? JSON.stringify(resultat.body) : '',
        stderr: '',
        ...(kind ? { kind } : {}),
      };
    },
  };
}
