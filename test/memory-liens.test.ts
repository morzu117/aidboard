import { expect, test } from 'vitest';
import { deriveMemoryLinks } from '../src/daemon/memory/liens.js';

const slug = 'aid/page/a';
const now = new Date('2026-11-23T12:00:00Z');
const derive = (frontmatter: Record<string, unknown>, body = '') =>
  deriveMemoryLinks({ slug, frontmatter, body }, now);

test('lit les quatre types déclarés et les citations hors code', () => {
  expect(
    derive(
      {
        liens: {
          precise: ['aid/page/b'],
          contredit: ['aid/page/c'],
          remplace: ['aid/page/d'],
          issu_de: ['aid/page/e'],
        },
      },
      [
        '[[aid/page/f]] [[Invalide]] `[[aid/page/g]]`',
        '``x ` [[aid/page/h]]``',
        '   ````md',
        '```',
        '[[aid/page/i]]',
        '   `````',
        '[[aid/page/j]]',
        '> ```',
        '> [[aid/page/k]]',
        '> ```',
        '> [[aid/page/l]]',
      ].join('\n'),
    ),
  ).toEqual({
    closed: false,
    liens: [
      { from: slug, to: 'aid/page/b', type: 'precise' },
      { from: slug, to: 'aid/page/c', type: 'contredit' },
      { from: slug, to: 'aid/page/d', type: 'remplace' },
      { from: slug, to: 'aid/page/e', type: 'issu_de' },
      { from: slug, to: 'aid/page/f', type: 'cite' },
      { from: slug, to: 'aid/page/j', type: 'cite' },
      { from: slug, to: 'aid/page/l', type: 'cite' },
    ],
    erreurs: [],
  });
});

test.each([
  ['issu_de', 'aid/page/b', { from: slug, to: 'aid/page/b', type: 'issu_de' }, false],
  ['remplacee_par', 'aid/page/b', { from: 'aid/page/b', to: slug, type: 'remplace' }, true],
  ['remplacee_par', ['aid/page/b'], { from: 'aid/page/b', to: slug, type: 'remplace' }, true],
  ['doublon_de', 'aid/page/b', { from: 'aid/page/b', to: slug, type: 'remplace' }, true],
])('%s produit une arête orientée', (key, value, edge, closed) => {
  expect(derive({ [key]: value })).toEqual({ closed, liens: [edge], erreurs: [] });
});

test('écarte les entrées fautives et conserve les liens valides', () => {
  expect(
    derive(
      {
        liens: {
          cite: ['aid/page/b'],
          precise: 'aid/page/b',
          contredit: ['invalide', 'aid/page/c', slug],
        },
        remplacee_par: [slug],
        doublon_de: null,
        issu_de: ['aid/page/b'],
      },
      `[[${slug}]]`,
    ),
  ).toEqual({
    closed: false,
    liens: [{ from: slug, to: 'aid/page/c', type: 'contredit' }],
    erreurs: [
      'liens.cite : type de lien inconnu',
      'liens.precise : liste de slugs valides attendue',
      'liens.contredit : slug invalide ("invalide") dans la liste',
      'liens.contredit : lien vers soi-même (aid/page/a)',
      'issu_de : slug valide attendu',
      'remplacee_par : lien vers soi-même (aid/page/a)',
      'doublon_de : slug valide attendu',
    ],
  });
  expect(derive({ liens: [] }).erreurs).toEqual([
    'liens : objet de types vers des listes de slugs attendu',
  ]);
  expect(derive({ remplacee_par: [] })).toEqual({ closed: false, liens: [], erreurs: [] });
});

test.each([
  [{ close_le: '2026-11-23' }, true, []],
  [{ close_le: '2026-11-23T13:00:00+01:00' }, true, []],
  [{ close_le: '2026-11-24' }, false, ['close_le : date dans le futur']],
  [{ close_le: '2026-11-23T12:00:00.001Z' }, false, ['close_le : date dans le futur']],
  [
    { close_le: '2026-11-22', valide_depuis: '2026-11-23' },
    false,
    ['close_le : date antérieure à valide_depuis'],
  ],
  [
    { close_le: '2026-02-30T12:00Z', valide_depuis: '23/11/2026' },
    false,
    [
      'valide_depuis : date attendue (AAAA-MM-JJ ou instant ISO 8601)',
      'close_le : date attendue (AAAA-MM-JJ ou instant ISO 8601)',
    ],
  ],
])('valide les dates %j', (frontmatter, closed, erreurs) => {
  expect(derive(frontmatter)).toEqual({ closed, liens: [], erreurs });
});

test('une page qui se cite elle-même dans son corps reste écrivable', () => {
  expect(derive({}, `Voir [[${slug}]] et [[aid/page/b]].`)).toEqual({
    closed: false,
    liens: [{ from: slug, to: 'aid/page/b', type: 'cite' }],
    erreurs: [],
  });
});
