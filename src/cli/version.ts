import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Le bundle place ses chunks à des profondeurs variables : on remonte jusqu'au package.json du paquet.
export function packageRoot(from = dirname(fileURLToPath(import.meta.url))): string {
  let dir = from;
  for (let i = 0; i < 6; i++) {
    const file = join(dir, 'package.json');
    if (existsSync(file)) {
      const pkg = JSON.parse(readFileSync(file, 'utf8')) as { name?: string; version?: string };
      if (pkg.name === 'aidboard' && pkg.version) return dir;
    }
    dir = dirname(dir);
  }
  throw new Error('package.json de aidboard introuvable');
}

export function readVersion(from = dirname(fileURLToPath(import.meta.url))): string {
  const dir = packageRoot(from);
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version: string };
  return pkg.version;
}
