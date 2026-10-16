import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type * as NodePty from 'node-pty';

let loaded: typeof NodePty | null = null;

export function getPty(): typeof NodePty {
  if (!loaded) throw new Error('node-pty non initialisé : appeler ptyPreflight() au démarrage');
  return loaded;
}

// node-pty 1.1.0 livre spawn-helper en 0644 : sans exécution possible, macOS répond « posix_spawnp failed ».
export function fixSpawnHelperMode(): void {
  if (process.platform !== 'darwin') return;
  const root = dirname(createRequire(import.meta.url).resolve('node-pty/package.json'));
  const prebuilds = join(root, 'prebuilds');
  if (!existsSync(prebuilds)) return;
  for (const dir of readdirSync(prebuilds).filter((d) => d.startsWith('darwin-'))) {
    const helper = join(prebuilds, dir, 'spawn-helper');
    if (existsSync(helper) && (statSync(helper).mode & 0o111) === 0) chmodSync(helper, 0o755);
  }
}

export async function ptyPreflight(): Promise<void> {
  try {
    fixSpawnHelperMode();
    loaded = createRequire(import.meta.url)('node-pty') as typeof NodePty;
  } catch (err) {
    throw new Error(
      `node-pty ne se charge pas : ${(err as Error).message}. ` +
        'Linux et WSL2 : sudo apt install build-essential python3, puis npm rebuild node-pty.',
    );
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('node-pty : le lancement de test ne rend pas la main')),
      5000,
    );
    try {
      const probe = loaded!.spawn('/bin/sh', ['-c', 'exit 0'], {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
      });
      probe.onExit(() => {
        clearTimeout(timer);
        resolve();
      });
    } catch (err) {
      clearTimeout(timer);
      reject(new Error(`node-pty ne sait pas lancer un processus : ${(err as Error).message}`));
    }
  });
}
