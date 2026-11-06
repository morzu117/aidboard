import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';

/**
 * Chantier 29 (D156) : la mémoire disponible d'une machine, pas la mémoire libre brute. `os.freemem()` ne compte sur
 * macOS que les pages libres, quelques centaines de Mo sur un Mac qui va bien : les pages inactives et
 * spéculatives se récupèrent sans rien tuer.
 */

/** Une commande POSIX, la même pour un serveur Linux ou un Mac distant. */
export const MEMOIRE_CMD =
  'if [ -r /proc/meminfo ]; then grep MemAvailable /proc/meminfo; else vm_stat; fi';

/** `vm_stat` (macOS) : pages libres, inactives et spéculatives, fois la taille de page de l'en-tête. */
export function parseVmStat(out: string): number | null {
  const page = /page size of (\d+) bytes/.exec(out)?.[1];
  if (!page) return null;
  const pages = (nom: string) => {
    const v = new RegExp(`^Pages ${nom}:\\s+(\\d+)\\.?\\s*$`, 'm').exec(out)?.[1];
    return v === undefined ? null : Number(v);
  };
  const libres = pages('free');
  if (libres === null) return null;
  return (libres + (pages('inactive') ?? 0) + (pages('speculative') ?? 0)) * Number(page);
}

/** `/proc/meminfo` (Linux) : `MemAvailable`, en kio. */
export function parseMeminfo(out: string): number | null {
  const v = /^MemAvailable:\s+(\d+)\s*kB\s*$/m.exec(out)?.[1];
  return v === undefined ? null : Number(v) * 1024;
}

/** La sortie de `MEMOIRE_CMD`, quelle que soit la branche jouée ; null si elle est illisible. */
export function parseMemoire(out: string): number | null {
  return parseMeminfo(out) ?? parseVmStat(out);
}

/** Sur ce Mac (ou le Linux de la CI) : null si la mesure échoue, jamais d'exception. */
export async function memoireLocale(
  platform: NodeJS.Platform = process.platform,
): Promise<number | null> {
  if (platform === 'linux') return readFile('/proc/meminfo', 'utf8').then(parseMeminfo, () => null);
  if (platform !== 'darwin') return null;
  return new Promise((resolve) => {
    execFile('vm_stat', [], { timeout: 3000, env: { PATH: '/usr/bin:/bin' } }, (err, stdout) =>
      resolve(err ? null : parseVmStat(String(stdout))),
    );
  });
}
