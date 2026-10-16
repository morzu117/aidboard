import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Le bundle tsup place ses fichiers à des profondeurs variables : on remonte jusqu'au dossier voulu.
export function findAssetDir(
  name: string,
  marker: string,
  from = dirname(fileURLToPath(import.meta.url)),
): string {
  let dir = from;
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, name);
    if (existsSync(join(candidate, marker))) return candidate;
    dir = dirname(dir);
  }
  throw new Error(`dossier ${name} introuvable depuis ${from}`);
}
