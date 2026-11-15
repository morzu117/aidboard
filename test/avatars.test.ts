import { describe, expect, test } from 'vitest';
import { avatarCell, couleurCell, initialesCell, PALETTE_AVATARS } from '../src/shared/avatars.js';
import { ConfigError, parseConfig } from '../src/daemon/config.js';

test.each([
  ['peer-a', 'PA'],
  ['principal', 'PR'],
  ['aid_e2e', 'AE'],
  ['', '?'],
  ['perso', 'PE'],
  ['東京', '東京'],
  ['peer.b', 'PB'],
  ['peer b', 'PB'],
  ['---', '?'],
  ['peer-2', 'P2'],
])('initiales de %s : %s', (nom, attendu) => {
  expect(initialesCell(nom)).toBe(attendu);
});

test('couleur stable, FNV-1a et répartition sur sept couleurs, gris réservé', () => {
  expect(couleurCell('principal')).toBe(couleurCell('principal'));
  expect(couleurCell('principal')).toBe('ambre');
  const couleurs = Array.from({ length: 20 }, (_, i) => couleurCell(`peer-${i}`));
  expect(new Set(couleurs).size).toBeGreaterThanOrEqual(4);
  expect(couleurs).not.toContain('gris');
  expect(couleurCell('')).toBe('gris');
});

test('surcharges partielles, complètes et absentes', () => {
  expect(avatarCell('peer-a', { 'peer-a': { initiales: 'A1' } })).toEqual({
    initiales: 'A1',
    couleur: couleurCell('peer-a'),
  });
  expect(avatarCell('peer-b', { 'peer-b': { couleur: 'rose' } })).toEqual({
    initiales: 'PB',
    couleur: 'rose',
  });
  expect(avatarCell('principal', { principal: { initiales: 'P', couleur: 'bleu' } })).toEqual({
    initiales: 'P',
    couleur: 'bleu',
  });
  expect(avatarCell('perso')).toEqual({ initiales: 'PE', couleur: couleurCell('perso') });
  expect(avatarCell('constructor')).toEqual({
    initiales: 'CO',
    couleur: couleurCell('constructor'),
  });
});

test('palette historique du rail : valeurs, ordre et encres inchangés', () => {
  expect(PALETTE_AVATARS.map(({ id, nom, valeur, ink }) => [id, nom, valeur, ink])).toEqual([
    ['menthe', 'Menthe', '#5de0a1', '#06251a'],
    ['violet', 'Violet', '#a78bfa', '#1b1238'],
    ['orange', 'Orange', '#f59e6b', '#3a1a06'],
    ['bleu', 'Bleu', '#6ea8ff', '#0b2347'],
    ['rose', 'Rose', '#f07ab0', '#3d0f26'],
    ['ambre', 'Ambre', '#f2b84b', '#2a1d00'],
    ['turquoise', 'Turquoise', '#4fd1d9', '#062f33'],
    ['gris', 'Gris', '#8d94a0', '#14161a'],
  ]);
});

const config = (avatars: unknown) => parseConfig(JSON.stringify({ avatars })).avatars;

describe('validation de la config avatars', () => {
  test('table facultative, surcharge partielle ou complète, unicode et limites admises', () => {
    expect(parseConfig('').avatars).toEqual({});
    expect(
      config({
        'peer-a': { initiales: 'A1', couleur: 'bleu' },
        'peer-b': { couleur: 'rose' },
        principal: {},
        perso: { initiales: '東2' },
      }),
    ).toEqual({
      'peer-a': { initiales: 'A1', couleur: 'bleu' },
      'peer-b': { couleur: 'rose' },
      principal: {},
      perso: { initiales: '東2' },
    });
    expect(
      Object.keys(
        config(Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`peer-${i}`, {}]))),
      ),
    ).toHaveLength(200);
    expect(config({ ['p'.repeat(64)]: { couleur: 'gris' } })).toBeDefined();
    expect(Object.hasOwn(config(JSON.parse('{"__proto__":{"couleur":"bleu"}}')), '__proto__')).toBe(
      true,
    );
  });
  test.each([null, [], 'peer-a', 1])('refuse une table invalide %j', (valeur) => {
    expect(() => config(valeur)).toThrow('avatars doit être une table');
  });
  test.each(['', 'peer a', 'peer\ta', 'peer\u0000a', 'p'.repeat(65)])('refuse la clé %j', (nom) => {
    expect(() => config({ [nom]: {} })).toThrow('clé invalide');
  });
  test.each([null, [], 'A1', 1])('refuse une valeur non objet %j', (valeur) => {
    expect(() => config({ 'peer-a': valeur })).toThrow('avatars.peer-a doit être un objet');
  });
  test.each(['', 'ABC', 'A-', '<', 'A B', 12, null])('refuse les initiales %j', (initiales) => {
    expect(() => config({ 'peer-a': { initiales } })).toThrow('avatars.peer-a.initiales');
  });
  test.each(['#6ea8ff', 'Bleu', '', 1, null])('refuse la couleur %j', (couleur) => {
    expect(() => config({ 'peer-a': { couleur } })).toThrow('avatars.peer-a.couleur');
  });
  test('refuse une clé inconnue et plus de 200 entrées', () => {
    expect(() => config({ 'peer-a': { image: 'example.com' } })).toThrow(
      'clé inconnue dans config.yaml : avatars.peer-a.image',
    );
    expect(() =>
      config(Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`peer-${i}`, {}]))),
    ).toThrow(ConfigError);
  });
});
