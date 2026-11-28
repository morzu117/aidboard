import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import { OPTIONS_GIT_SUJET } from '../git/exec.js';

export interface ProfilIsolation {
  worktree: string;
  gitCommun: string;
  home: string;
  aidHome: string;
  spool: string;
  piecesJointes: string;
  tmp?: string;
  gitDir?: string;
  copieClaude?: string;
  projetClaude?: string;
}

export const POINTS_PROJET = [
  ['.claude', true],
  ['.mcp.json', false],
] as const;

interface FsIsolation {
  existsSync(path: string): boolean;
  lstatSync?(
    path: string,
    options: { throwIfNoEntry: false },
  ): { isDirectory(): boolean; isFile(): boolean } | undefined;
  readlinkSync?(path: string): string;
  realpathSync?(path: string): string;
  statSync(path: string): { isDirectory(): boolean; isFile(): boolean };
}

function validerChemin(nom: string, chemin: string): void {
  if (!isAbsolute(chemin) || /[\r\n]/.test(chemin)) {
    throw new Error(`Isolation bwrap : ${nom} doit être un chemin absolu sans fin de ligne`);
  }
}

export function argvBwrap(
  profil: ProfilIsolation,
  { pty, sourcePreuve }: { pty: boolean; sourcePreuve?: string },
  fs: FsIsolation,
): string[] {
  for (const [nom, chemin] of Object.entries(profil)) {
    if (chemin === undefined) continue;
    validerChemin(nom, chemin);
  }

  const { worktree, gitCommun, gitDir, home, aidHome, spool, piecesJointes } = profil;
  const argv = [
    '--ro-bind',
    '/',
    '/',
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    '--tmpfs',
    '/tmp',
    '--tmpfs',
    '/run',
    '--die-with-parent',
    '--unshare-pid',
  ];
  if (!pty) argv.push('--new-session');
  // node-pty ajoute PWD après le filtrage de l’environnement.
  else argv.push('--unsetenv', 'PWD');

  const resolv = '/etc/resolv.conf';
  if (fs.existsSync(resolv) && fs.readlinkSync && fs.realpathSync) {
    let lien: string | undefined;
    try {
      lien = resolve(dirname(resolv), fs.readlinkSync(resolv));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'EINVAL') throw cause;
    }
    const cible = fs.realpathSync(resolv);
    const destination = lien?.startsWith('/run/') ? lien : cible;
    if (
      cible.startsWith('/run/') &&
      destination !== '/run/user' &&
      !destination.startsWith('/run/user/') &&
      fs.statSync(cible).isFile()
    ) {
      argv.push('--ro-bind', cible, destination);
    }
  }

  argv.push('--tmpfs', aidHome);
  for (const relatif of ['.ssh', '.gnupg', '.config/gh']) {
    const chemin = join(home, relatif);
    if (fs.existsSync(chemin) && fs.statSync(chemin).isDirectory()) argv.push('--tmpfs', chemin);
  }
  const credentials = join(home, '.git-credentials');
  if (fs.existsSync(credentials) && fs.statSync(credentials).isFile()) {
    argv.push('--ro-bind', '/dev/null', credentials);
  }

  // node_modules dans le checkout de preuve pointe vers le worktree du sujet.
  if (sourcePreuve) {
    validerChemin('sourcePreuve', sourcePreuve);
    argv.push('--ro-bind', sourcePreuve, sourcePreuve);
  }
  for (const chemin of [worktree, gitCommun, spool, piecesJointes]) {
    argv.push('--bind', chemin, chemin);
  }
  if (profil.tmp) argv.push('--bind', profil.tmp, profil.tmp);
  for (const [relatif, dossier] of POINTS_PROJET) {
    const chemin = join(worktree, relatif);
    const statut = fs.lstatSync
      ? fs.lstatSync(chemin, { throwIfNoEntry: false })
      : fs.existsSync(chemin)
        ? fs.statSync(chemin)
        : undefined;
    if (statut && !(dossier ? statut.isDirectory() : statut.isFile())) {
      throw new Error(
        `Isolation bwrap : ${chemin} doit être un ${dossier ? 'dossier' : 'fichier'} ordinaire`,
      );
    }
    argv.push('--ro-bind', chemin, chemin);
  }

  for (const relatif of ['.npm', '.cache']) {
    const chemin = join(home, relatif);
    if (fs.existsSync(chemin)) argv.push('--bind', chemin, chemin);
  }

  for (const relatif of ['.claude', '.codex']) {
    const chemin = join(home, relatif);
    if (fs.existsSync(chemin)) argv.push('--ro-bind', chemin, chemin);
  }
  for (const relatif of [
    '.claude/.credentials.json',
    '.claude/sessions',
    '.codex/auth.json',
    '.codex/sessions',
    '.codex/archived_sessions',
  ]) {
    const chemin = join(home, relatif);
    if (!fs.existsSync(chemin)) continue;
    const dossierCli = join(home, relatif.split('/')[0]!);
    if (
      fs.realpathSync &&
      fs.realpathSync(chemin) !== join(fs.realpathSync(dossierCli), basename(chemin))
    )
      continue;
    argv.push('--bind', chemin, chemin);
  }
  if (profil.projetClaude) {
    const projet = profil.projetClaude;
    const memoire = join(projet, 'memory');
    argv.push('--bind', projet, projet, '--ro-bind', memoire, memoire);
    for (const relatif of ['todos', 'shell-snapshots', 'statsig', 'debug', 'session-env']) {
      const chemin = join(home, '.claude', relatif);
      const statut = fs.lstatSync
        ? fs.lstatSync(chemin, { throwIfNoEntry: false })
        : fs.existsSync(chemin)
          ? fs.statSync(chemin)
          : undefined;
      if (!statut) continue;
      if (!statut.isDirectory()) {
        throw new Error(`Isolation bwrap : ${chemin} doit être un dossier ordinaire`);
      }
      argv.push('--tmpfs', chemin);
    }
  }
  if (profil.copieClaude) {
    argv.push('--bind', profil.copieClaude, join('/tmp', basename(dirname(profil.copieClaude))));
    argv.push('--bind', profil.copieClaude, join(home, '.claude.json'));
  }

  const pointeur = join(worktree, '.git');
  const recouvrements = [
    ...(fs.existsSync(pointeur) && fs.statSync(pointeur).isFile() ? [pointeur] : []),
    ...(gitDir && gitDir !== gitCommun
      ? ['commondir', 'gitdir'].map((relatif) => join(gitDir, relatif))
      : []),
    ...['config', 'hooks', 'refs/heads/main', 'packed-refs'].map((relatif) =>
      join(gitCommun, relatif),
    ),
  ];
  for (const chemin of recouvrements) {
    if (fs.existsSync(chemin)) argv.push('--ro-bind', chemin, chemin);
  }
  return argv;
}

export function gitCommunDe(
  worktree: string,
  exec: (bin: string, args: string[]) => string,
): string {
  validerChemin('worktree', worktree);
  let sortie: string;
  try {
    sortie = exec('git', [
      ...OPTIONS_GIT_SUJET,
      '-C',
      worktree,
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ]);
  } catch (cause) {
    throw new Error(
      `Impossible de déterminer le répertoire git commun de ${worktree} : ${String(cause)}`,
      { cause },
    );
  }
  const chemin = sortie.replace(/\r?\n$/, '');
  validerChemin('gitCommun', chemin);
  return chemin;
}
