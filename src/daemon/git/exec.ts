import { execFile } from 'node:child_process';

export interface GitResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

export const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' };

export const GIT_ENV_LECTURE = { ...GIT_ENV, GIT_OPTIONAL_LOCKS: '0' };

// Liste positive : les écritures et les sous-commandes inconnues gardent leur environnement.
function estLecture(args: string[]): boolean {
  // Les diff de livraison précisent leurs réglages avant la sous-commande.
  while (args[0] === '-c' && args.length > 2) args = args.slice(2);
  return (
    [
      'rev-parse',
      'show-ref',
      'rev-list',
      'for-each-ref',
      'log',
      'status',
      'show',
      'diff',
      'diff-tree',
      'merge-base',
      'ls-remote',
    ].includes(args[0] ?? '') ||
    (args[0] === 'symbolic-ref' &&
      (args.length === 3 || args.length === 4) &&
      args[1] === '--quiet' &&
      (args.length === 3 || args[2] === '--short')) ||
    (args[0] === 'remote' && args[1] === 'get-url') ||
    (args[0] === 'worktree' && args[1] === 'list') ||
    (args[0] === 'stash' && args[1] === 'list') ||
    (args[0] === 'config' &&
      args.length === 2 &&
      (args[1] === 'user.name' || args[1] === 'user.email'))
  );
}

// Jamais de shell : execFile avec un tableau d'arguments. Ne lève pas, rend le code de sortie.
export function git(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd,
        env: { ...process.env, ...(estLecture(args) ? GIT_ENV_LECTURE : GIT_ENV) },
        maxBuffer: 16 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        const code = err ? ((err as { code?: number | string }).code ?? null) : 0;
        resolve({
          ok: !err,
          code: typeof code === 'number' ? code : null,
          // Fin seulement : `status --porcelain` (11.7) commence parfois une ligne par une
          // espace significative (colonne d'index vide) — un .trim() plein la mangeait et
          // décalait tout le parsing en largeur fixe d'un caractère.
          stdout: String(stdout).replace(/\s+$/, ''),
          stderr: String(stderr).trim(),
        });
      },
    );
  });
}
