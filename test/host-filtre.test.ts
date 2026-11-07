import { expect, test } from 'vitest';
import { filtrerTexte, texteCoupe } from '../src/daemon/host/filtre.js';

const valeurs = [
  '/Users/exemple/projet',
  '/home/exemple/projet',
  '/var/log/service',
  '~/projet/fichier',
  '$HOME/projet/fichier',
  '${HOME}/projet/fichier',
  '~exemple/projet/fichier',
  ...['sk_live_', 'sk_test_', 'rk_live_', 'sk-', 'ghp_'].flatMap((prefixe) => [
    prefixe + 'abcdefgh',
    prefixe + 'a'.repeat(40),
  ]),
  'C:\\exemple\\fichier',
  'https://example.com/page',
  'http://example.com',
  'ws://example.com',
  'wss://example.com',
  'file:///tmp/exemple',
  'ssh://example.com/projet',
  'git@example.com:projet.git',
  'aid-e2e.ts.net',
  '192.0.2.1',
  '203.0.113.42',
  '2001:db8::1',
  '2001:db8:0:0:0:0:0:1',
  '::1',
  '::',
  '::ffff:192.0.2.1',
  'YWJjZGVmZ2hpamtsbW5vcHFy',
  'YWJjZGVmZ2hpamtsbW5vcH-_',
  'abcdef0123456789abcdef01',
  'sk-exemple',
  'ghp_exemple',
  'gho_exemple',
  'ghs_exemple',
  'github_pat_exemple',
  'xoxa-exemple',
  'xoxb-exemple',
  'xoxp-exemple',
  'xoxr-exemple',
  'AKIAEXEMPLE',
  'eyJleGVtcGxlIjoxfQ.exemple.signature',
  'glpat-exemple',
];

test.each(valeurs)('masque le motif synthétique %s', (valeur) => {
  expect(filtrerTexte(`Valeur ${valeur} fin`)).toBe('Valeur [masqué] fin');
});

const textes = [
  'La tâche est prête : vérifiée, relue et terminée !',
  'anticonstitutionnellement est long',
  'branche feat/32-mobile-application-installee',
  'voir docs/chantiers/32-mobile.md',
  'ConfigurationDuModeHostAppareil',
  'PR #125',
  '2026-11-07',
  '14:32',
  'Progression : 75 %',
  'feat/32-mobile',
  'src/app.ts',
  '1/2',
  '',
];

test.each(textes)('préserve le texte ordinaire %s', (texte) => {
  expect(filtrerTexte(texte)).toBe(texte);
});

test('normalise les contrôles et fusionne les masques', () => {
  expect(filtrerTexte('  Bonjour\n\r\t\u0000monde  ')).toBe('Bonjour monde');
  expect(filtrerTexte('[masqué][masqué]\n[masqué]')).toBe('[masqué]');
  expect(filtrerTexte('https://example.com  192.0.2.1')).toBe('[masqué]');
});

test('coupe à 140 caractères en fin de mot si possible', () => {
  expect(filtrerTexte('é'.repeat(140))).toBe('é'.repeat(140));
  expect(filtrerTexte('é'.repeat(141))).toBe(`${'é'.repeat(139)}…`);
  expect(filtrerTexte('mot '.repeat(40))).toBe(`${'mot '.repeat(35).trim()}…`);
});

test('ne coupe jamais un masque', () => {
  for (let longueur = 130; longueur < 140; longueur++) {
    const resultat = filtrerTexte(`${'é'.repeat(longueur)} [masqué] suite longue`);
    expect(resultat.length).toBeLessThanOrEqual(140);
    expect(resultat.replace('[masqué]', '')).not.toMatch(/\[|\]/);
  }
});

test('est idempotent, y compris après une coupe', () => {
  for (const texte of [...valeurs, ...textes, 'mot '.repeat(40), '[masqué] '.repeat(30)]) {
    const resultat = filtrerTexte(texte);
    expect(filtrerTexte(resultat)).toBe(resultat);
  }
});

test('masque une IPv6 suivie de ponctuation', () => {
  expect(filtrerTexte('Adresse : 2001:db8::1.')).toBe('Adresse : [masqué].');
});

const phrasesSensibles = [
  ['le jeton aB3dE5fG7hI9jK1lM3nO5pQ7 fuit', 'le jeton [masqué] fuit'],
  ['clé deadbeefdeadbeefdeadbeefdeadbeef', 'clé [masqué]'],
  ['JWT eyJleGVtcGxlIjoxfQ.exemple.signature', 'JWT [masqué]'],
  ['base64 aB3dE5fG7hI9/jK1lM3nO5pQ7+ fuit', 'base64 [masqué] fuit'],
];

test.each(phrasesSensibles)('masque la valeur sensible dans %s', (texte, attendu) => {
  const resultat = filtrerTexte(texte);
  expect(resultat).toBe(attendu);
  expect(filtrerTexte(resultat)).toBe(resultat);
});

test('la coupe est mesurée après masquage', () => {
  expect(texteCoupe('é'.repeat(141))).toBe(true);
  expect(texteCoupe('é'.repeat(140))).toBe(false);
  expect(texteCoupe('/' + 'a'.repeat(160))).toBe(false);
});

test('reste utilisable directement dans map', () => {
  expect(['Aucune revue', '2 contrôles en panne'].map(filtrerTexte)).toEqual([
    'Aucune revue',
    '2 contrôles en panne',
  ]);
});
