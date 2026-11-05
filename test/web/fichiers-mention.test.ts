import { expect, test } from 'vitest';
import type { FilesResponse } from '../../src/shared/files.js';
import {
  aplatir,
  FICHIERS_MAX,
  filtrerFichiers,
  insererMention,
  saisieMention,
} from '../../web/src/conversation/fichiersMention.js';

/** Chantier 26 (D118) : les règles du menu `@` du composer. */

const arbre: FilesResponse = {
  tree: [
    {
      name: 'src',
      path: 'src',
      kind: 'dir',
      status: '',
      entries: [
        { name: 'app.ts', path: 'src/app.ts', kind: 'file', status: 'M' },
        {
          name: 'lib',
          path: 'src/lib',
          kind: 'dir',
          status: '',
          entries: [{ name: 'mapper.ts', path: 'src/lib/mapper.ts', kind: 'file', status: '' }],
        },
      ],
    },
    { name: 'README.md', path: 'README.md', kind: 'file', status: '' },
  ],
  total: 3,
  modified: 1,
  truncated: true,
};

test('aplatir : les fichiers seuls, dans l’ordre de l’arbre, et la troncature', () => {
  expect(aplatir(arbre)).toEqual({
    chemins: ['src/app.ts', 'src/lib/mapper.ts', 'README.md'],
    tronque: true,
  });
});

test('saisieMention : le dernier mot, s’il commence par @ ; pas une adresse', () => {
  expect(saisieMention('@')).toBe('');
  expect(saisieMention('regarde @src/ap')).toBe('src/ap');
  expect(saisieMention('regarde\n@ma')).toBe('ma');
  expect(saisieMention('regarde @src/app.ts ')).toBeNull();
  expect(saisieMention('écris à julien@exemple')).toBeNull();
  expect(saisieMention('rien')).toBeNull();
});

test('filtrerFichiers : par nom d’abord, puis par chemin ; insensible à la casse ; borné', () => {
  const chemins = aplatir(arbre).chemins;
  expect(filtrerFichiers(chemins, '')).toEqual(chemins);
  expect(filtrerFichiers(chemins, 'MA')).toEqual(['src/lib/mapper.ts']);
  // « a » : app.ts commence par a ; mapper.ts et README.md le contiennent
  expect(filtrerFichiers(chemins, 'a')).toEqual(['src/app.ts', 'src/lib/mapper.ts', 'README.md']);
  expect(filtrerFichiers(chemins, 'lib/')).toEqual(['src/lib/mapper.ts']);
  const beaucoup = Array.from({ length: 80 }, (_, i) => `f${i}.ts`);
  expect(filtrerFichiers(beaucoup, 'f')).toHaveLength(FICHIERS_MAX);
});

test('insererMention : remplace la mention en cours, une espace après ; un $ du chemin reste tel quel', () => {
  expect(insererMention('regarde @ap', 'src/app.ts')).toBe('regarde @src/app.ts ');
  expect(insererMention('@', 'a/$&.ts')).toBe('@a/$&.ts ');
});
