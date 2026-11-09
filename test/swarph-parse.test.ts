import { expect, test } from 'vitest';
import {
  parsePeers,
  parseRights,
  parseCodegraph,
  parseMemoryList,
  parseMemoryPage,
  parseMemoryLinks,
  requeteCodegraphValide,
  slugValide,
  tagValide,
  typeValide,
} from '../src/shared/swarph.js';

test('pairs : deux colonnes, espaces et lignes vides ; toute ligne mal formée invalide la lecture', () => {
  expect(parsePeers('\n peer-a  1.0\r\npeer-b\t2.0\n')?.value).toEqual([
    { nom: 'peer-a', version: '1.0' },
    { nom: 'peer-b', version: '2.0' },
  ]);
  expect(parsePeers('')?.value).toEqual([]);
  expect(parsePeers('peer-a 1.0 inconnu')).toBeNull();
  expect(parsePeers('peer-a')).toBeNull();
  expect(parsePeers(null)).toBeNull();
});

test('droits : champs inconnus ignorés, valeurs inconnues conservées et direct déduit si absent', () => {
  expect(
    parseRights({
      peer: 'peer-a',
      groups: ['g', 3],
      inconnu: true,
      grants: [
        {
          grant_type: 'futur',
          target: 'peer-b',
          level: 'futur',
          direct: false,
          via_group: null,
          inconnu: true,
        },
        { via_group: null },
        { via_group: 'g' },
        {},
        { direct: true },
        { direct: 'oui' },
        null,
      ],
    })?.value,
  ).toEqual({
    peer: 'peer-a',
    groups: ['g'],
    grants: [
      { grant_type: 'futur', target: 'peer-b', level: 'futur', direct: false },
      ...[true, false, false, true, null].map((direct) => ({
        grant_type: null,
        target: null,
        level: null,
        direct,
      })),
    ],
  });
  expect(parseRights({})?.value).toEqual({ peer: null, groups: [], grants: [] });
  expect(parseRights({ peer: 3, groups: {}, grants: 'illisible' })?.value).toEqual({
    peer: null,
    groups: [],
    grants: [],
  });
  expect(parseRights([])).toBeNull();
});

test('codegraph : liste brute, champs inconnus ignorés, nom obligatoire et nombres entiers', () => {
  expect(
    parseCodegraph([
      {
        repo: 'depot',
        name: 'fonction',
        kind: 'futur',
        file_path: 'src/a.ts',
        start_line: 4,
        callers: 2,
        qualified_name: 'a.fonction',
        signature: '()',
        docstring: 'texte',
        score: 1,
      },
    ])?.value,
  ).toEqual([
    {
      repo: 'depot',
      name: 'fonction',
      kind: 'futur',
      file_path: 'src/a.ts',
      start_line: 4,
      callers: 2,
      qualified_name: 'a.fonction',
      signature: '()',
      docstring: 'texte',
    },
  ]);
  expect(parseCodegraph([{}, null, { name: '' }, { name: 3 }])?.value).toEqual([]);
  expect(parseCodegraph([{ name: 'f', callers: '2', start_line: 1.5 }])?.value[0]).toEqual({
    name: 'f',
    repo: null,
    kind: null,
    file_path: null,
    start_line: null,
    callers: null,
    qualified_name: null,
    signature: null,
    docstring: null,
  });
  expect(parseCodegraph({})).toBeNull();
});

test('codegraph : textes bornés à 300 caractères et docstring à 500', () => {
  const texte = 'a'.repeat(501);
  const ligne = parseCodegraph([
    {
      name: texte,
      repo: texte,
      kind: texte,
      file_path: texte,
      qualified_name: texte,
      signature: texte,
      docstring: texte,
    },
  ])?.value[0];
  for (const champ of ['name', 'repo', 'kind', 'file_path', 'qualified_name', 'signature'] as const)
    expect(ligne?.[champ]).toHaveLength(300);
  expect(ligne?.docstring).toHaveLength(500);
});

test('mémoire liste : slug obligatoire, métadonnées tolérantes, champs inconnus ignorés', () => {
  expect(
    parseMemoryList([
      { slug: 'page/a', title: 'Titre', type: 'futur', tags: ['tag', 2], inconnu: true },
      { slug: 'page/b' },
      {},
      null,
      { slug: '' },
    ])?.value,
  ).toEqual([
    { slug: 'page/a', title: 'Titre', type: 'futur', tags: ['tag'] },
    { slug: 'page/b', title: null, type: null, tags: [] },
  ]);
  expect(parseMemoryList({})).toBeNull();
});

test('mémoire page : compiled_truth prioritaire, ancien content accepté, corps brut et borné', () => {
  expect(
    parseMemoryPage({
      slug: 'page/a',
      title: 'Titre',
      type: 'futur',
      tags: ['tag'],
      compiled_truth: '<b>texte</b>',
      content: 'ancien',
      inconnu: true,
    })?.value,
  ).toEqual({
    slug: 'page/a',
    title: 'Titre',
    type: 'futur',
    tags: ['tag'],
    content: '<b>texte</b>',
  });
  expect(parseMemoryPage({ slug: 'page/a', content: 'ancien' })?.value.content).toBe('ancien');
  expect(
    parseMemoryPage({ slug: 'page/a', compiled_truth: '', content: 'ancien' })?.value.content,
  ).toBe('');
  expect(
    parseMemoryPage({ slug: 'page/a', compiled_truth: 3, content: 'ancien' })?.value.content,
  ).toBe('ancien');
  for (const champ of ['content', 'compiled_truth'])
    expect(
      parseMemoryPage({ slug: 'page/a', [champ]: 'a'.repeat(200_001) })?.value.content,
    ).toHaveLength(200_000);
  expect(parseMemoryPage({ slug: 'page/a' })?.value.content).toBeNull();
  expect(parseMemoryPage({})).toBeNull();
  expect(parseMemoryPage('illisible')).toBeNull();
});

test('mémoire liens : arêtes OKF, direction inconnue conservée, extrémités obligatoires', () => {
  expect(
    parseMemoryLinks([
      {
        type: 'edge',
        from: 'page/a',
        to: 'page/b',
        rel: 'futur',
        direction: 'future',
        hop: 2,
        inconnu: true,
      },
      { from: 'page/b', to: 'page/a', hop: 1.5 },
      {},
      null,
    ])?.value,
  ).toEqual([
    { from: 'page/a', to: 'page/b', direction: 'future', hop: 2 },
    { from: 'page/b', to: 'page/a', direction: null, hop: null },
  ]);
  expect(parseMemoryLinks({})).toBeNull();
});

test('listes vides valides et version du schéma compatible avec Parsed', () => {
  for (const parseur of [parseCodegraph, parseMemoryList, parseMemoryLinks]) {
    expect(parseur([])).toEqual({ value: [], schemaVersion: null });
    expect(parseur(null)).toBeNull();
  }
  expect(parseRights({ schema_version: 2 })?.schemaVersion).toBe('2');
  expect(parseMemoryPage({ slug: 'page/a', schema_version: 'future' })?.schemaVersion).toBe(
    'future',
  );
});

test('requête codegraph : limites inclusives, tiret initial et tous les contrôles refusés', () => {
  for (const valeur of ['a', 'a'.repeat(200), 'nom qualifié', 'a-b'])
    expect(requeteCodegraphValide(valeur)).toBe(true);
  for (const valeur of ['', 'a'.repeat(201), '-x', null, 3])
    expect(requeteCodegraphValide(valeur)).toBe(false);
  for (let code = 0; code <= 159; code++) {
    if (code < 32 || code >= 127)
      expect(requeteCodegraphValide(`a${String.fromCharCode(code)}b`)).toBe(false);
  }
});

test('slugs et tags : alphabet fermé, premier caractère alphanumérique, limites inclusives', () => {
  for (const valide of [slugValide, tagValide]) {
    for (const valeur of ['a', 'A0._:/-z', 'a'.repeat(200)]) expect(valide(valeur)).toBe(true);
    for (const valeur of ['', 'a'.repeat(201), '-a', '/a', '.a', 'é', 'a b', 'a\n', 'a?', null, 3])
      expect(valide(valeur)).toBe(false);
  }
});

test('types : minuscule initiale, alphabet fermé et limite de 64 caractères', () => {
  for (const valeur of ['a', 'note', 'a0_-', 'a'.repeat(64)]) expect(typeValide(valeur)).toBe(true);
  for (const valeur of ['', 'Note', '0note', '-note', 'a/b', 'a b', 'a\n', 'a'.repeat(65), null, 3])
    expect(typeValide(valeur)).toBe(false);
});
