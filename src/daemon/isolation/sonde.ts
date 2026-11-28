import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { resolveOnPath } from '../pty/spawn.js';

export interface BwrapDisponible {
  bin: string;
  version: string;
}

function executer(bin: string, args: string[], timeout: number) {
  return spawnSync(bin, args, { timeout, encoding: 'utf8' });
}

export function sonderBwrap({
  platform = process.platform,
  path = process.env.PATH ?? '',
  chercher = resolveOnPath,
  exec = executer,
}: {
  platform?: NodeJS.Platform;
  path?: string;
  chercher?: typeof resolveOnPath;
  exec?: typeof executer;
} = {}): BwrapDisponible {
  if (platform !== 'linux') throw new Error(`isolation bwrap indisponible sur ${platform}`);
  const prefixe = 'isolation demandée mais bubblewrap indisponible : ';
  const fichier = chercher('bwrap', path);
  if (!fichier) throw new Error(prefixe + 'bwrap absent du PATH');
  const bin = resolve(fichier);
  const verifier = (args: string[]) => {
    const resultat = exec(bin, args, 5000);
    if (resultat.error || resultat.status !== 0) {
      const detail =
        resultat.stderr?.trim().slice(-500) ||
        resultat.error?.message ||
        resultat.signal ||
        `code ${resultat.status}`;
      throw new Error(prefixe + detail);
    }
    return resultat.stdout.trim();
  };
  verifier(['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--', '/bin/true']);
  return { bin, version: verifier(['--version']) };
}
