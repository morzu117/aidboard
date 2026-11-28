import { spawn } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { SpawnChild } from '../conversation/driver.js';
import { OPTIONS_GIT_SUJET } from '../git/exec.js';
import type { AidPaths } from '../paths.js';
import { resolveOnPath } from '../pty/spawn.js';
import { argvBwrap, gitCommunDe, POINTS_PROJET, type ProfilIsolation } from './bwrap.js';

type FsIsolation = Parameters<typeof argvBwrap>[2];

export interface IsolationCommande {
  bwrapBin: string;
  profil: ProfilIsolation;
}

export class BubblewrapIndisponible extends Error {
  constructor() {
    super('isolation demandée mais bubblewrap indisponible');
  }
}

let dossierMasquage: string | undefined;

function preparerFichierVide(profil: ProfilIsolation, depot?: string): string {
  const racines = [profil.home, profil.worktree, ...(depot ? [depot] : [])].map((chemin) =>
    realpathSync(chemin),
  );
  const horsRacines = (dossier: string) =>
    racines.every((racine) => {
      const chemin = relative(racine, dossier);
      return chemin === '..' || chemin.startsWith('..' + sep) || isAbsolute(chemin);
    });
  let dossier = realpathSync(profil.aidHome);
  if (!horsRacines(dossier)) {
    const temporaire = realpathSync(tmpdir());
    if (!horsRacines(temporaire)) {
      throw new Error('Isolation bwrap : aucun dossier de masquage hors du home et du worktree');
    }
    if (!dossierMasquage) {
      const prive = mkdtempSync(join(temporaire, 'aid-masquage-'));
      process.once('exit', () => rmSync(prive, { recursive: true, force: true }));
      dossierMasquage = prive;
    }
    dossier = dossierMasquage;
    if (!horsRacines(dossier)) {
      throw new Error('Isolation bwrap : dossier de masquage dans le home ou le worktree');
    }
  }
  const chemin = join(dossier, 'masque-vide');
  if (!lstatSync(chemin, { throwIfNoEntry: false })) {
    // Publie le fichier seulement une fois son mode définitif appliqué.
    const provisoire = mkdtempSync(join(dossier, 'aid-masquage-'));
    try {
      const vide = join(provisoire, 'vide');
      writeFileSync(vide, '', { flag: 'wx', mode: 0o444 });
      chmodSync(vide, 0o444);
      try {
        linkSync(vide, chemin);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
      }
    } finally {
      rmSync(provisoire, { recursive: true, force: true });
    }
  }
  const statut = lstatSync(chemin);
  if (!statut.isFile() || statut.size !== 0 || (statut.mode & 0o7777) !== 0o444) {
    throw new Error(`Isolation bwrap : ${chemin} doit être un fichier ordinaire vide en 0444`);
  }
  return chemin;
}

export function profilPour(
  {
    worktree,
    home,
    paths,
    agentId,
    depot,
  }: {
    worktree: string;
    home: string;
    paths: AidPaths;
    agentId: string;
    depot?: string;
  },
  exec: Parameters<typeof gitCommunDe>[1],
  fs: FsIsolation,
): ProfilIsolation {
  const profil: ProfilIsolation = {
    worktree,
    gitCommun: gitCommunDe(worktree, exec),
    home,
    aidHome: paths.home,
    spool: paths.spool,
    piecesJointes: join(paths.attachments, agentId),
  };
  const canonique = fs.realpathSync ?? ((chemin: string) => chemin);
  if (depot && canonique(gitCommunDe(depot, exec)) !== canonique(profil.gitCommun)) {
    throw new Error('GIT_COMMUN_INATTENDU : répertoire Git commun différent du dépôt du sujet');
  }
  const pointeur = join(worktree, '.git');
  if (fs.existsSync(pointeur) && fs.statSync(pointeur).isFile()) {
    profil.gitDir = exec('git', [
      ...OPTIONS_GIT_SUJET,
      '-C',
      worktree,
      'rev-parse',
      '--path-format=absolute',
      '--git-dir',
    ]).replace(/\r?\n$/, '');
  }
  if (fs.existsSync(paths.home)) profil.fichierVide = preparerFichierVide(profil, depot);
  // Valide les chemins avant que le manager ne démarre le pilote.
  argvBwrap(profil, { pty: false }, fs);
  return profil;
}

const ENV_ISOLE = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TERM',
  'LANG',
  'TZ',
  'TMPDIR',
  'AID_URL',
  'AID_TOKEN',
  'AID_TOPIC',
  'AID_RUN',
  'AID_AGENT',
  'AID_SPOOL',
  'AID_HOOK',
  'AID_NODE',
  'AID_CLI',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'DISABLE_AUTOUPDATER',
]);

export function environnementIsole(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([nom, valeur]) =>
        ENV_ISOLE.has(nom) ||
        nom.startsWith('LC_') ||
        (nom === 'CODEX_HOME' && env.HOME && valeur === join(env.HOME, '.codex')),
    ),
  );
}

function copieConfigurationClaude(profil: ProfilIsolation, fs: FsIsolation) {
  const chemin = join(profil.home, '.claude.json');
  if (!fs.existsSync(chemin)) return undefined;
  const dossier = mkdtempSync(join(tmpdir(), 'aid-claude-'));
  const nettoyer = () => rmSync(dossier, { recursive: true, force: true });
  try {
    const copie = join(dossier, '.claude.json');
    copyFileSync(chemin, copie);
    return { copie, nettoyer };
  } catch (cause) {
    nettoyer();
    throw cause;
  }
}

function optionsCliIsolee(file: string, args: string[], worktree: string): string[] {
  const cli = basename(file);
  if (cli === 'claude') {
    const separateur = args.indexOf('--');
    const options = separateur === -1 ? args : args.slice(0, separateur);
    return options.includes('--strict-mcp-config') ? [] : ['--strict-mcp-config'];
  }
  // Une table TOML garde le chemin entier comme clé, y compris s’il contient des points.
  if (cli === 'codex')
    return ['-c', `projects={${JSON.stringify(worktree)}={trust_level="trusted"}}`];
  return [];
}

const pointsMontage = new Map<string, { statut: Stats; utilisations: number }>();

function memePoint(statut: Stats | undefined, creation: Stats): boolean {
  return (
    statut?.dev === creation.dev &&
    statut.ino === creation.ino &&
    statut.birthtimeMs === creation.birthtimeMs
  );
}

function retenirPointMontage(chemin: string, dossier: boolean): (() => void) | undefined {
  let statut = lstatSync(chemin, { throwIfNoEntry: false });
  let point = pointsMontage.get(chemin);
  if (!point || !memePoint(statut, point.statut)) {
    if (statut) return undefined;
    try {
      if (dossier) mkdirSync(chemin);
      else writeFileSync(chemin, '', { flag: 'wx' });
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'EEXIST') return undefined;
      throw cause;
    }
    statut = lstatSync(chemin, { throwIfNoEntry: false });
    if (!statut) return undefined;
    point = { statut, utilisations: 0 };
    pointsMontage.set(chemin, point);
  }
  const creation = point;
  creation.utilisations++;
  return () => {
    if (--creation.utilisations !== 0 || pointsMontage.get(chemin) !== creation) return;
    pointsMontage.delete(chemin);
    try {
      const courant = lstatSync(chemin, { throwIfNoEntry: false });
      if (!courant || !memePoint(courant, creation.statut)) return;
      if (dossier) rmdirSync(chemin);
      else if (courant.isFile() && courant.size === 0) unlinkSync(chemin);
    } catch {
      // Un dossier rempli ou devenu inaccessible doit rester en place.
    }
  };
}

function preparerProjetClaude(home: string, worktree: string): string {
  const claude = join(home, '.claude');
  const projets = join(claude, 'projects');
  const projet = join(projets, worktree.replace(/[^A-Za-z0-9]/g, '-'));
  for (const chemin of [claude, projets, projet, join(projet, 'memory')]) {
    try {
      mkdirSync(chemin, { mode: 0o700 });
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
    }
    if (!lstatSync(chemin).isDirectory()) {
      throw new Error(`Isolation bwrap : ${chemin} doit être un dossier ordinaire`);
    }
  }
  return projet;
}

export function envelopper(
  bwrapBin: string,
  profil: ProfilIsolation,
  options: Parameters<typeof argvBwrap>[1],
  fs: FsIsolation,
  file: string,
  args: string[],
): { file: string; args: string[]; nettoyer?: () => void } {
  const nettoyages: (() => void)[] = [];
  const nettoyer = () => {
    for (const action of nettoyages.splice(0)) action();
  };
  try {
    const worktree = fs.realpathSync?.(profil.worktree) ?? profil.worktree;
    let projetClaude: string | undefined;
    if (fs.existsSync(worktree)) {
      for (const [relatif, dossier] of POINTS_PROJET) {
        const liberer = retenirPointMontage(join(worktree, relatif), dossier);
        if (liberer) nettoyages.push(liberer);
      }
      if (basename(file) === 'claude') projetClaude = preparerProjetClaude(profil.home, worktree);
    }
    const etat = options.masquerIdentifiants ? undefined : copieConfigurationClaude(profil, fs);
    if (etat) nettoyages.push(etat.nettoyer);
    const argv = argvBwrap(
      { ...profil, copieClaude: etat?.copie ?? profil.copieClaude, projetClaude },
      options,
      fs,
    );
    return {
      file: bwrapBin,
      args: [...argv, '--', file, ...optionsCliIsolee(file, args, worktree), ...args],
      ...(nettoyages.length > 0 && { nettoyer }),
    };
  } catch (cause) {
    nettoyer();
    throw cause;
  }
}

export function envelopperCommande(
  { bwrapBin, profil }: IsolationCommande,
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  sourcePreuve?: string,
) {
  const binaire = resolveOnPath(bwrapBin, env.PATH ?? '');
  if (!binaire) throw new BubblewrapIndisponible();
  const lancement = envelopper(
    resolve(binaire),
    { ...profil, tmp: env.TMPDIR },
    { pty: false, sourcePreuve, masquerIdentifiants: true },
    { existsSync, lstatSync, readlinkSync, realpathSync, statSync },
    file,
    args,
  );
  return { ...lancement, env: environnementIsole(env) };
}

export function spawnChildIsole(
  bwrapBin: string,
  profil: ProfilIsolation,
  fs: FsIsolation,
  spawnChild: SpawnChild = spawn,
): SpawnChild {
  return (bin, args, options) => {
    const lancement = envelopper(bwrapBin, profil, { pty: false }, fs, bin, args);
    try {
      const enfant = spawnChild(lancement.file, lancement.args, {
        ...options,
        env: environnementIsole(options.env),
      });
      if (lancement.nettoyer) enfant.once('close', lancement.nettoyer);
      return enfant;
    } catch (cause) {
      lancement.nettoyer?.();
      throw cause;
    }
  };
}
