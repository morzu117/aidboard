import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const repo = new URL('../', import.meta.url);
const exceptions =
  /^(?:docs\/chantiers\/|docs\/recette-chantier-[^/]*\.md$|design\/|kernel\/CHANGELOG\.md$|brief\.md$|test\/sans-gbrain\.test\.ts$)/;

test('les fichiers suivis ne prescrivent plus gbrain hors des exceptions', () => {
  const files = execFileSync('git', ['ls-files', '-z', '--deduplicate'], {
    cwd: repo,
    encoding: 'utf8',
  });
  const violations = files.split('\0').filter((file) => {
    if (!file || exceptions.test(file)) return false;

    // Le nom de l'outil est en minuscules ; les noms de variables en majuscules sont admis.
    const path = join(fileURLToPath(repo), file);
    return existsSync(path) && readFileSync(path, 'utf8').includes('gbrain');
  });
  expect(violations, violations.join('\n')).toEqual([]);
});
