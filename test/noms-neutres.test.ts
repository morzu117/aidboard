import { isUtf8 } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';

const racine = resolve(import.meta.dirname, '..');
const empreintesInterdites = new Set([
  'c0ab82d169373693ef572b8823d4891cde42f078790f554b83e963e57cf582d8',
  '67f529e88f0fb9c6a53265b17485b6c5eb4302eb1d0f177232173f919a4fb377',
  'a6d4b41ebbca787a96604add881bf09187f8ec2d912d95eb01337a31c670b457',
  '83da5acf41ea62e81dd1f92d9e306cdd72a0009b5dad0d1d3dcfed2c5014ad38',
]);

function verifierNomsNeutres(texte: string, fichier: string, empreintes: ReadonlySet<string>) {
  for (const mot of texte.match(/[A-Za-z0-9_-]+/g) ?? []) {
    const empreinte = createHash('sha256').update(mot.toLowerCase()).digest('hex');
    if (empreintes.has(empreinte)) {
      throw new Error(`Nom non neutre dans ${fichier}`);
    }
  }
}

test('les fichiers texte suivis utilisent des noms neutres', () => {
  const fichiers = execFileSync('git', ['ls-files', '-z'], { cwd: racine, encoding: 'utf8' });
  for (const fichier of fichiers.split('\0').filter(Boolean)) {
    if (fichier === 'package-lock.json') continue;
    const contenu = readFileSync(resolve(racine, fichier));
    if (contenu.includes(0) || !isUtf8(contenu)) continue;
    verifierNomsNeutres(contenu.toString('utf8'), fichier, empreintesInterdites);
  }
});

test('la garde rejette un nom interdit, même en majuscules', () => {
  const nom = 'nom-interdit';
  const empreintes = new Set([createHash('sha256').update(nom).digest('hex')]);
  for (const variante of [nom, nom.toUpperCase()]) {
    expect(() => verifierNomsNeutres(`(${variante}).`, 'exemple.txt', empreintes)).toThrow(
      'Nom non neutre dans exemple.txt',
    );
  }
  expect(() =>
    verifierNomsNeutres(
      'cell-aid cell-gestion cell-lab gateway',
      'exemple.txt',
      empreintesInterdites,
    ),
  ).not.toThrow();
});
