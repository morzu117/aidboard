import { expect, test } from 'vitest';
import { libelleBoard } from '../../web/src/ui/libellesBoard.js';

test.each([
  ['not-taken', 'non prise'],
  ['withdrawn', 'retirée'],
  ['requested', 'demandée'],
  ['unstaffable (free mesh explanation)', 'sans détenteur disponible (free mesh explanation)'],
  ['unstaffable (mesh\nexplanation)', 'sans détenteur disponible (mesh\nexplanation)'],
  ['nouvel-etat', 'nouvel-etat'],
  ['build', 'build'],
  ['pre-build (graph unfilled)', 'pre-build (graph unfilled)'],
  ['constructor', 'constructor'],
  ['texte libre active', 'texte libre active'],
  [null, '—'],
])('libellé board %s', (valeur, attendu) => {
  expect(libelleBoard(valeur)).toBe(attendu);
});
