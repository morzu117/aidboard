import { isUtf8 } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';

const racine = resolve(import.meta.dirname, '..');
const empreintesInterdites = new Set([
  '10fb93e25e0253e7dc9cd78af23092e4510f5240897c5d581001f3e1a2bc2742',
  '7811f8511991cc485c15cc6f478f4657447e2d1860ea42a71579aa55f8a39ff5',
  '3d37e768b95b3fbbcff2cb174c48631f43b14d3a225edc846920ceb297e93b47',
  'e9011d1f715c6f749c0d68bb48a9ba8d1d5513d93a49d096fc8d8d4b2e1c662e',
  'f0fd47934b1a412d5b71b4b876c2e28f18c9e7a0adac2028532b832ee3a955e9',
  '0a2633f8944a93d00dd5a018e00f9cf8e4d43da4387677b47301063a9a1c2f12',
  'c0ab82d169373693ef572b8823d4891cde42f078790f554b83e963e57cf582d8',
  '67f529e88f0fb9c6a53265b17485b6c5eb4302eb1d0f177232173f919a4fb377',
  'a6d4b41ebbca787a96604add881bf09187f8ec2d912d95eb01337a31c670b457',
  '83da5acf41ea62e81dd1f92d9e306cdd72a0009b5dad0d1d3dcfed2c5014ad38',
]);

const empreintesInterditesCode = new Set([
  'e23c3d7ff76f6e6235ce091f2fcd5fd35748677799d1637acf5ba2bca350e258',
]);

function verifierNomsNeutres(
  texte: string,
  fichier: string,
  empreintes: ReadonlySet<string>,
  empreintesCode?: ReadonlySet<string>,
) {
  const estCode = /^(e2e|test|src|web|scripts|app)\//.test(fichier);
  const mots = texte.match(/[A-Za-z0-9_-]+/g) ?? [];
  for (const mot of mots.flatMap((mot) => [mot, ...mot.split(/[_-]/)])) {
    const empreinte = createHash('sha256').update(mot.toLowerCase()).digest('hex');
    if (empreintes.has(empreinte) || (estCode && empreintesCode?.has(empreinte))) {
      throw new Error(`Nom non neutre dans ${fichier}`);
    }
  }
}

function verifierNomsNeutresCode(texte: string, fichier: string, empreintes: ReadonlySet<string>) {
  if (/^(e2e|test|src|web|scripts|app)\//.test(fichier)) {
    verifierNomsNeutres(texte, fichier, empreintes);
  }
}

test('les fichiers texte suivis utilisent des noms neutres', () => {
  const fichiers = execFileSync('git', ['ls-files', '-z'], { cwd: racine, encoding: 'utf8' });
  for (const fichier of fichiers.split('\0').filter(Boolean)) {
    if (fichier === 'package-lock.json') continue;
    const contenu = readFileSync(resolve(racine, fichier));
    if (contenu.includes(0) || !isUtf8(contenu)) continue;
    verifierNomsNeutres(
      contenu.toString('utf8'),
      fichier,
      empreintesInterdites,
      empreintesInterditesCode,
    );
  }
}, 30_000);

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

test('la garde du code rejette un nom interdit seulement dans les dossiers ciblés', () => {
  const nom = 'nom-interdit';
  const empreintes = new Set([createHash('sha256').update(nom).digest('hex')]);
  for (const dossier of ['e2e', 'test', 'src', 'web', 'scripts', 'app']) {
    const fichier = `${dossier}/exemple.ts`;
    expect(() => verifierNomsNeutresCode(nom, fichier, empreintes)).toThrow(
      `Nom non neutre dans ${fichier}`,
    );
  }
  expect(() => verifierNomsNeutresCode(nom, 'docs/exemple.md', empreintes)).not.toThrow();
});

test('la garde rejette un composant interdit dans un nom composé', () => {
  const nom = 'exemple';
  const empreintes = new Set([createHash('sha256').update(nom).digest('hex')]);
  for (const variante of ['improve_exemple_supervisor', 'improve-exemple-supervisor']) {
    expect(() => verifierNomsNeutres(variante, 'exemple.txt', empreintes)).toThrow(
      'Nom non neutre dans exemple.txt',
    );
  }
});
