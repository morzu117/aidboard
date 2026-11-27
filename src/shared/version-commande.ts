import { execFile } from 'node:child_process';

export const lireVersionCommande = (bin: string, args: string[], surStderr = false) =>
  new Promise<string | null>((resolve) => {
    execFile(bin, args, { timeout: 5000 }, (err, stdout, stderr) =>
      resolve(err ? null : ((surStderr ? stderr : stdout).trim().split('\n')[0] ?? '')),
    );
  });
