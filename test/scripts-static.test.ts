import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

// bash 3.2 (macOS) en locale UTF-8 colle un octet non ASCII à un nom de variable qui le précède (« $name… » devient
// une variable inconnue, `unbound variable` sous set -u). Le test d'install-server.sh ne le voit que si la locale
// existe sur la machine ; ce contrôle statique, lui, ne dépend de rien. Écrire ${name}… à la place.
const racine = join(import.meta.dirname, '..', 'scripts');
function scripts(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? scripts(join(dir, e.name))
      : e.name.endsWith('.sh')
        ? [join(dir, e.name)]
        : [],
  );
}

test('scripts .sh : aucun $variable collé à un caractère non ASCII', () => {
  const trouves: string[] = [];
  for (const f of scripts(racine)) {
    readFileSync(f, 'utf8')
      .split('\n')
      .forEach((l, i) => {
        if (/\$[A-Za-z_][A-Za-z0-9_]*[\u0080-\uFFFF]/.test(l)) trouves.push(`${f}:${i + 1}`);
      });
  }
  expect(trouves).toEqual([]);
});

test('le contrôle voit bien une variable collée à « … »', () => {
  expect(/\$[A-Za-z_][A-Za-z0-9_]*[\u0080-\uFFFF]/.test('echo "$name…"')).toBe(true);
  expect(/\$[A-Za-z_][A-Za-z0-9_]*[\u0080-\uFFFF]/.test('echo "${name}…"')).toBe(false);
});
