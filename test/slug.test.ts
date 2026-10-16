import { expect, test } from 'vitest';
import { isValidSlug, slugify } from '../src/shared/slug.js';

test('slugify retire accents, ponctuation et casse', () => {
  expect(slugify("Écran d'accueil v2 !")).toBe('ecran-d-accueil-v2');
});

test('un titre trop long est tronqué à 48 sans tiret final', () => {
  const s = slugify(`${'a'.repeat(47)} bbbbbbbbbb`);
  expect(s).toHaveLength(47);
  expect(s.endsWith('-')).toBe(false);
  expect(isValidSlug(s)).toBe(true);
  expect(slugify('x'.repeat(60))).toHaveLength(48);
});

test('un chemin remonté ne laisse que des lettres', () => {
  expect(slugify('../../etc')).toBe('etc');
});

test('un titre sans lettre ni chiffre est refusé', () => {
  expect(() => slugify('')).toThrow();
  expect(() => slugify('!!! ???')).toThrow();
});

test('isValidSlug refuse tiret initial, majuscule et caractères hors grammaire', () => {
  for (const bad of ['-a', 'A', 'a b', 'a/b', 'a'.repeat(49), ''])
    expect(isValidSlug(bad)).toBe(false);
  expect(isValidSlug('a-b-1')).toBe(true);
});
