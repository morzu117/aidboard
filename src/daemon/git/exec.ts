import { execFile } from 'node:child_process';

export interface GitResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

export const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' };

// Jamais de shell : execFile avec un tableau d'arguments. Ne lève pas, rend le code de sortie.
export function git(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, env: { ...process.env, ...GIT_ENV }, maxBuffer: 16 * 1024 * 1024 },
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
