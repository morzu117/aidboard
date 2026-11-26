import { execFile, spawn } from 'node:child_process';
import { lstat, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { git, lireCommits, racineDepot } from './verifier.js';

const executer = promisify(execFile);
const delaiDixMinutes = 10 * 60 * 1000;

interface Suite {
  passed: number;
  failed: number;
  ids: string[];
}

interface Commande {
  argv: string[];
  exit: number | null;
  head: string;
  delai_depasse?: true;
}

export interface PreuveD5 {
  schema_version: 1;
  repo: string;
  head: string;
  base: string;
  outcome: 'pass' | 'fail' | 'cannot_evaluate';
  commands: Commande[];
  not_checked: string[];
  suites: { base: Suite; head: Suite };
  pass_to_fail: string[];
  fail_to_pass?: string[];
}

interface OptionsPreuve {
  depot: string;
  base: string;
  chemins: readonly string[];
  lancer: Record<string, string>;
}

async function nomDepot(depot: string, lireGit: typeof git): Promise<string> {
  const origine = (await lireGit(depot, ['remote', 'get-url', 'origin'])).trim();
  const chemin = origine.includes('://')
    ? new URL(origine).pathname
    : origine.replace(/^[^/]+:/, '');
  const segments = chemin
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .split('/')
    .filter(Boolean);
  if (segments.length < 2) throw new Error('Le remote origin doit désigner un dépôt owner/name');
  return segments.slice(-2).join('/');
}

function lancerEnGroupe(
  dossier: string,
  head: string,
  argv: string[],
  delai: number,
  env?: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<Commande> {
  return new Promise((resoudre, rejeter) => {
    const [programme, ...args] = argv;
    const enfant = spawn(programme!, args, { cwd: dossier, env, detached: true, stdio: 'ignore' });
    let expire = false;
    function tuer() {
      if (!enfant.pid) return;
      try {
        process.kill(-enfant.pid, 'SIGKILL');
      } catch (erreur) {
        if ((erreur as NodeJS.ErrnoException).code !== 'ESRCH') rejeter(erreur);
      }
    }
    const minuteur = setTimeout(() => {
      expire = true;
      tuer();
    }, delai);
    function nettoyer() {
      clearTimeout(minuteur);
      signal?.removeEventListener('abort', tuer);
    }
    signal?.addEventListener('abort', tuer, { once: true });
    if (signal?.aborted) tuer();
    enfant.once('error', (erreur) => {
      nettoyer();
      rejeter(erreur);
    });
    enfant.once('exit', (code) => {
      nettoyer();
      tuer();
      resoudre({
        argv,
        head,
        exit: expire || signal?.aborted ? null : code,
        ...(expire && { delai_depasse: true as const }),
      });
    });
  });
}

async function lancerDansWorktree(
  depot: string,
  head: string,
  argv: string[],
  delai: number,
  env?: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  lireGit = git,
): Promise<Commande> {
  signal?.throwIfAborted();
  const dossier = await mkdtemp(join(tmpdir(), 'aid-preuve-worktree-'));
  let ajoute = false;
  try {
    await lireGit(depot, ['worktree', 'add', '--detach', dossier, head]);
    ajoute = true;
    const modules = join(depot, 'node_modules');
    const dependances = await lstat(modules).catch((erreur: NodeJS.ErrnoException) => {
      if (erreur.code !== 'ENOENT') throw erreur;
    });
    if (dependances) await symlink(modules, join(dossier, 'node_modules'), 'dir');

    const [programme, ...args] = argv;
    try {
      if (lireGit !== git) return await lancerEnGroupe(dossier, head, argv, delai, env, signal);
      await executer(programme!, args, {
        cwd: dossier,
        timeout: delai,
        killSignal: 'SIGKILL',
        env,
        signal,
      });
      return { argv, exit: 0, head };
    } catch (erreur) {
      const arret = erreur as { code?: number; killed?: boolean; signal?: string };
      if (arret.killed && arret.signal === 'SIGKILL') {
        return { argv, exit: null, head, delai_depasse: true };
      }
      if (typeof arret.code === 'number') return { argv, exit: arret.code, head };
      if (arret.signal) return { argv, exit: null, head };
      if (erreur instanceof Error) throw new Error(`Impossible de lancer ${programme}`);
      throw erreur;
    }
  } finally {
    try {
      if (ajoute) await lireGit(depot, ['worktree', 'remove', '--force', dossier]);
    } finally {
      try {
        await rm(dossier, { recursive: true, force: true });
      } finally {
        await lireGit(depot, ['worktree', 'prune']);
      }
    }
  }
}

function noter(suite: Suite, fichier: string, commande: Commande): void {
  suite.ids.push(fichier);
  if (commande.exit === 0) suite.passed++;
  else suite.failed++;
}

export async function produirePreuves(
  { depot, base, chemins, lancer }: OptionsPreuve,
  delai = delaiDixMinutes,
  env?: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  lireGit = git,
): Promise<{ point: string; preuve: PreuveD5; fautes: string[] }[]> {
  depot = await racineDepot(depot, lireGit);
  const head = (await lireGit(depot, ['rev-parse', 'HEAD'])).trim();
  const commits = await lireCommits(depot, base, head, lireGit);
  const points = new Map<string, (typeof commits)[number]>();
  for (const commit of commits) {
    for (const point of commit.points) {
      if (!points.has(point)) points.set(point, commit);
    }
  }
  const repo = await nomDepot(depot, lireGit);
  const prefixes = chemins.map((chemin) => chemin.replace(/\/+$/, '') + '/');
  const commandes = Object.entries(lancer).sort(([a], [b]) => b.length - a.length);
  const rapports = [];
  for (const [point, commit] of [...points].sort(([a], [b]) =>
    a.localeCompare(b, 'fr', { numeric: true }),
  )) {
    const fichiers = new Set(
      commit.changements
        .filter(({ statut }) => statut !== 'D')
        .map(({ fichier, destination }) => destination ?? fichier)
        .filter((fichier) => prefixes.some((prefixe) => fichier.startsWith(prefixe))),
    );
    const preuve: PreuveD5 = {
      schema_version: 1,
      repo,
      head,
      base: commit.sha,
      outcome: 'pass',
      commands: [],
      not_checked: [],
      suites: {
        base: { passed: 0, failed: 0, ids: [] },
        head: { passed: 0, failed: 0, ids: [] },
      },
      pass_to_fail: [],
      fail_to_pass: [],
    };
    const fautes: string[] = [];
    for (const fichier of fichiers) {
      const commande = commandes.find(([prefixe]) => fichier.startsWith(prefixe))?.[1];
      if (!commande) {
        preuve.not_checked.push(fichier);
        continue;
      }
      const argv = commande
        .trim()
        .split(/\s+/)
        .map((arg) => (arg === '{fichiers}' ? fichier : arg));
      const avant = await lancerDansWorktree(depot, commit.sha, argv, delai, env, signal, lireGit);
      const apres = await lancerDansWorktree(depot, head, argv, delai, env, signal, lireGit);
      preuve.commands.push(avant, apres);
      noter(preuve.suites.base, fichier, avant);
      noter(preuve.suites.head, fichier, apres);
      if (avant.exit === null || apres.exit === null) {
        preuve.not_checked.push(fichier);
        continue;
      }
      if (avant.exit === 0 || apres.exit !== 0) fautes.push(fichier);
      if (avant.exit === 0 && apres.exit !== 0) preuve.pass_to_fail.push(fichier);
      if (avant.exit !== 0 && apres.exit === 0) preuve.fail_to_pass!.push(fichier);
    }
    if (fautes.length) preuve.outcome = 'fail';
    else if (preuve.not_checked.length) preuve.outcome = 'cannot_evaluate';
    rapports.push({ point, preuve, fautes });
  }
  return rapports;
}

export async function prouverAcceptation(options: OptionsPreuve): Promise<PreuveD5[]> {
  return (await produirePreuves(options)).map(({ preuve }) => preuve);
}
