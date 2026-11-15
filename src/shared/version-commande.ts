import { execFile } from 'node:child_process';

export const lireVersionCommande = (bin: string, args: string[]) =>
  new Promise<string | null>((resolve) => {
    execFile(bin, args, { timeout: 5000 }, (err, stdout) =>
      resolve(err ? null : (stdout.trim().split('\n')[0] ?? '')),
    );
  });
