import { existsSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type { InstallMode } from '../shared/model.js';
import { repoRootFrom } from './updateCheck.js';

// Chantier 13 (DR4, DR5) : comment ce daemon a été installé se lit sur le disque, jamais dans
// une config. Mode `release` : le build tourne sous ~/.aid/server/<version>/ (une archive
// extraite, `current` pointe dessus). Mode `repo` : un clone git au-dessus du build (le
// développeur, `npm link`). `inconnu` : ni l'un ni l'autre (tarball npm installé à la main) —
// la mise à jour est alors désactivée, `aid doctor` le dit.

const SERVER_DIR = 'server';
const CURRENT = 'current';

export function serverDir(home: string): string {
  return join(home, SERVER_DIR);
}

// Chemin réel (liens résolus, /var → /private/var sous macOS) même si la feuille n'existe pas
// encore : on remonte au premier ancêtre existant, pour comparer deux chemins de même nature.
function realOrResolved(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    const parent = dirname(p);
    return parent === p ? resolve(p) : join(realOrResolved(parent), basename(p));
  }
}

/** `entry` : le chemin (réel ou non) du build qui tourne — `dist/cli/aid.js` ou un de ses chunks. */
export function installMode(entry: string, home: string): InstallMode {
  const real = realOrResolved(entry);
  const root = realOrResolved(serverDir(home));
  if (real.startsWith(root + sep)) return 'release';
  if (repoRootFrom(dirname(real))) return 'repo';
  return 'inconnu';
}

/** La version active (cible du lien `current`), ou null si rien n'est installé. */
export function currentServer(home: string): { version: string; dir: string } | null {
  const link = join(serverDir(home), CURRENT);
  let target: string;
  try {
    target = resolve(serverDir(home), readlinkSync(link));
  } catch {
    return null;
  }
  if (!existsSync(target)) return null;
  return { version: basename(target), dir: target };
}

const OS: Partial<Record<NodeJS.Platform, 'darwin' | 'linux'>> = {
  darwin: 'darwin',
  linux: 'linux',
};
const ARCH: Partial<Record<NodeJS.Architecture, 'arm64' | 'x64'>> = { arm64: 'arm64', x64: 'x64' };

/** Nom de l'asset de release pour une plateforme (DR3) ; lève hors darwin/linux × arm64/x64. */
export function assetName(
  version: string,
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): string {
  const os = OS[platform];
  const cpu = ARCH[arch];
  if (!os || !cpu) {
    throw new Error(
      `pas d'archive AID Server pour ${platform}-${arch} : darwin et linux seulement (Windows : WSL2)`,
    );
  }
  return `aid-server-${version}-${os}-${cpu}.tar.gz`;
}
