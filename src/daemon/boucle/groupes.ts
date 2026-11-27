import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface GroupeBoucle {
  pid: number;
  heureDepart: string;
}

export type ConsignerGroupe = (pid: number) => (() => void) | undefined;

export function heureDepartGroupe(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return;
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(join('/proc', String(pid), 'stat'), 'utf8');
      // Le nom du processus entre parenthèses peut contenir des espaces et des parenthèses.
      const champs = stat
        .slice(stat.lastIndexOf(')') + 2)
        .trim()
        .split(/\s+/);
      if (Number(champs[2]) === pid) return champs[19];
    }
    if (process.platform === 'darwin') {
      const resultat = execFileSync('ps', ['-p', String(pid), '-o', 'pgid=', '-o', 'lstart='], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 1_000,
      }).trim();
      const champs = /^(\d+)\s+(.+)$/.exec(resultat);
      if (Number(champs?.[1]) === pid) return champs?.[2];
    }
  } catch {
    // Un chef déjà sorti ne permet plus d'identifier le groupe.
  }
}

export function memeGroupe({ pid, heureDepart }: GroupeBoucle): boolean {
  return Boolean(heureDepart && heureDepartGroupe(pid) === heureDepart);
}
