import { isAbsolute, join } from 'node:path';

export interface ProfilIsolation {
  worktree: string;
  gitCommun: string;
  home: string;
  aidHome: string;
  spool: string;
  piecesJointes: string;
  tmp?: string;
}

interface FsIsolation {
  existsSync(path: string): boolean;
  statSync(path: string): { isDirectory(): boolean; isFile(): boolean };
}

function validerChemin(nom: string, chemin: string): void {
  if (!isAbsolute(chemin) || /[\r\n]/.test(chemin)) {
    throw new Error(`Isolation bwrap : ${nom} doit être un chemin absolu sans fin de ligne`);
  }
}

export function argvBwrap(
  profil: ProfilIsolation,
  { pty }: { pty: boolean },
  fs: FsIsolation,
): string[] {
  for (const [nom, chemin] of Object.entries(profil)) {
    if (nom === 'tmp' && chemin === undefined) continue;
    validerChemin(nom, chemin);
  }

  const { worktree, gitCommun, home, aidHome, spool, piecesJointes } = profil;
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
    '--die-with-parent',
    '--unshare-pid',
  ];
  if (!pty) argv.push('--new-session');

  argv.push('--tmpfs', aidHome);
  for (const relatif of ['.ssh', '.gnupg', '.config/gh']) {
    const chemin = join(home, relatif);
    if (fs.existsSync(chemin) && fs.statSync(chemin).isDirectory()) argv.push('--tmpfs', chemin);
  }
  const credentials = join(home, '.git-credentials');
  if (fs.existsSync(credentials) && fs.statSync(credentials).isFile()) {
    argv.push('--ro-bind', '/dev/null', credentials);
  }

  for (const chemin of [worktree, gitCommun, spool, piecesJointes]) {
    argv.push('--bind', chemin, chemin);
  }
  for (const relatif of ['.claude', '.claude.json', '.codex', '.npm', '.cache']) {
    const chemin = join(home, relatif);
    if (fs.existsSync(chemin)) argv.push('--bind', chemin, chemin);
  }

  const recouvrements = [
    ...['config', 'hooks', 'refs/heads/main', 'packed-refs'].map((relatif) =>
      join(gitCommun, relatif),
    ),
    ...['settings.json', 'CLAUDE.md', 'commands', 'agents', 'skills', 'plugins'].map((relatif) =>
      join(home, '.claude', relatif),
    ),
    join(home, '.codex/config.toml'),
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
