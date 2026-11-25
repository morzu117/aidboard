import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const executer = promisify(execFile);

export interface RapportVerifier {
  ok: boolean;
  points: Record<string, { commits: string[]; fichiers: string[] }>;
  fautes: {
    commit: string;
    fichier: string;
    raison: 'hors_chemins' | 'modifie_par_dev' | 'renomme_par_dev' | 'supprime_par_dev';
  }[];
}

interface Changement {
  statut: string;
  fichier: string;
  destination?: string;
}

interface Commit {
  sha: string;
  points: string[];
  changements: Changement[];
}

async function git(depot: string, args: string[]): Promise<string> {
  const { stdout } = await executer('git', args, {
    cwd: depot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

export async function racineDepot(depot: string): Promise<string> {
  return (await git(depot, ['rev-parse', '--show-toplevel'])).replace(/\n$/, '');
}

async function lireCommits(depot: string, base: string): Promise<Commit[]> {
  const shaBase = (
    await git(depot, ['rev-parse', '--verify', '--end-of-options', base + '^{commit}'])
  ).trim();
  const journal = await git(depot, [
    'log',
    '--reverse',
    '--topo-order',
    '--no-color',
    '--name-status',
    '-z',
    '-M',
    '--format=%x00%H%x00%(trailers:key=Acceptation,valueonly)',
    shaBase + '..HEAD',
    '--',
  ]);

  // Les chemins sont délimités par NUL, même quand ils contiennent des tabulations ou des sauts de ligne.
  const champs = journal.split('\0');
  champs.pop();
  const commits: Commit[] = [];
  let courant: Commit | undefined;
  for (let i = 0; i < champs.length;) {
    const champ = champs[i++]!;
    if (champ === '') {
      const sha = champs[i++]!;
      const points = champs[i++]!.split('\n')
        .map((point) => point.trim())
        .filter(Boolean);
      courant = { sha, points, changements: [] };
      commits.push(courant);
      continue;
    }
    const statut = champ.trim()[0]!;
    const fichier = champs[i++]!;
    const destination = statut === 'R' || statut === 'C' ? champs[i++]! : undefined;
    courant!.changements.push({ statut, fichier, destination });
  }
  return commits;
}

export async function verifierAcceptation({
  depot,
  base,
  chemins,
}: {
  depot: string;
  base: string;
  chemins: readonly string[];
}): Promise<RapportVerifier> {
  const commits = await lireCommits(depot, base);
  const prefixes = chemins.map((chemin) => chemin.replace(/\/+$/, '') + '/');
  const points = new Map<string, { commits: string[]; fichiers: Set<string>; premier: number }>();
  const fautesParCommit = commits.map(() => [] as RapportVerifier['fautes']);

  for (const [indice, { sha, points: marques, changements }] of commits.entries()) {
    if (marques.length === 0) continue;
    const fichiers = new Set<string>();
    for (const { statut, fichier, destination } of changements) {
      for (const touche of destination === undefined ? [fichier] : [fichier, destination]) {
        if (!prefixes.some((prefixe) => touche.startsWith(prefixe))) {
          fautesParCommit[indice]!.push({ commit: sha, fichier: touche, raison: 'hors_chemins' });
        }
      }
      if (statut !== 'D') fichiers.add(destination ?? fichier);
    }
    for (const point of new Set(marques)) {
      const detail = points.get(point) ?? {
        commits: [],
        fichiers: new Set<string>(),
        premier: indice,
      };
      detail.commits.push(sha);
      for (const fichier of fichiers) detail.fichiers.add(fichier);
      points.set(point, detail);
    }
  }

  const premiersParFichier = new Map<string, number>();
  for (const { fichiers, premier } of points.values()) {
    for (const fichier of fichiers) {
      premiersParFichier.set(
        fichier,
        Math.min(premiersParFichier.get(fichier) ?? premier, premier),
      );
    }
  }

  for (const [indice, { sha, points: marques, changements }] of commits.entries()) {
    if (marques.length > 0) continue;
    for (const { statut, fichier, destination } of changements) {
      const touche = statut === 'C' ? destination! : fichier;
      if (indice <= (premiersParFichier.get(touche) ?? Infinity)) continue;
      const raison =
        statut === 'R'
          ? 'renomme_par_dev'
          : statut === 'D'
            ? 'supprime_par_dev'
            : 'modifie_par_dev';
      fautesParCommit[indice]!.push({ commit: sha, fichier: touche, raison });
    }
  }

  const fautes = fautesParCommit.flat();
  return {
    ok: fautes.length === 0,
    points: Object.fromEntries(
      Array.from(points, ([point, detail]) => [
        point,
        { commits: detail.commits, fichiers: [...detail.fichiers] },
      ]),
    ),
    fautes,
  };
}
