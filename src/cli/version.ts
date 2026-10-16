import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Le bundle place ses chunks à des profondeurs variables : on remonte jusqu'au package.json du paquet.
export function readVersion(from = dirname(fileURLToPath(import.meta.url))): string {
  let dir = from;
  for (let i = 0; i < 6; i++) {
    const file = join(dir, 'package.json');
    if (existsSync(file)) {
      const pkg = JSON.parse(readFileSync(file, 'utf8')) as { name?: string; version?: string };
      if (pkg.name === 'aidboard' && pkg.version) return pkg.version;
    }
    dir = dirname(dir);
  }
  throw new Error('package.json de aidboard introuvable');
}
