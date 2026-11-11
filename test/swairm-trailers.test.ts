import { expect, test } from 'vitest';
import { parseTrailers } from '../src/shared/swairm-trailers.js';

import { bloc } from './fixtures/swairm-trailers.js';

test('contrat Swairm : champs obligatoires et drone facultatif, CRLF, autres trailers', () => {
  expect(parseTrailers(`titre\n\n${bloc}\n`)).toEqual({
    subject: 'feat/exemple',
    step: 's1',
    planVersion: 1,
    rung: 'standard',
    attempt: 3,
    proof: 'passed',
    lines: 12,
    files: 2,
    drone: null,
  });
  const message = `titre\n\n${bloc}\nSwairm-Drone: machine-a/42@2026-11-11\nCo-Authored-By: Exemple <exemple@example.com>\n`;
  expect(parseTrailers(message.replaceAll('\n', '\r\n'))?.drone).toBe('machine-a/42@2026-11-11');
  expect(parseTrailers(`titre\n\n${bloc.replace('Swairm-Step: s1', 'Swairm-Step:s1')}`)?.step).toBe(
    's1',
  );
});

test('seule la dernière section compte, jamais le titre ni les imitations dans le corps', () => {
  for (const message of [
    bloc,
    'titre',
    'titre\n\nun corps libre\nsur deux lignes',
    `titre\n\n${bloc}\n\nUn texte après`,
    `titre\n\n${bloc}\n\nSwairm-Step: autre`,
  ])
    expect(parseTrailers(message)).toBeNull();
  expect(parseTrailers(`titre\n\nSwairm-Subject: faux\n\n${bloc}`)?.subject).toBe('feat/exemple');
  expect(parseTrailers(`titre\n \t\n${bloc}`)?.step).toBe('s1');
});

test('chaque clé obligatoire doit être présente et les clés Swairm ne se répètent pas', () => {
  for (const ligne of bloc.split('\n')) {
    expect(
      parseTrailers(
        `titre\n\n${bloc
          .split('\n')
          .filter((l) => l !== ligne)
          .join('\n')}`,
      ),
    ).toBeNull();
    expect(parseTrailers(`titre\n\n${bloc}\n${ligne}`)).toBeNull();
  }
  for (const cle of ['Swairm-Drone', 'Swairm-Inconnu'])
    expect(parseTrailers(`titre\n\n${bloc}\n${cle}: x\n${cle}: y`)).toBeNull();
});

test.each([
  ['Swairm-Attempt: 3', 'Swairm-Attempt: trois'],
  ['Swairm-Attempt: 3', 'Swairm-Attempt: 0'],
  ['Swairm-Plan-Version: 1', 'Swairm-Plan-Version: -1'],
  ['Swairm-Lines: 12', 'Swairm-Lines: -1'],
  ['Swairm-Files: 2', 'Swairm-Files: 1.5'],
  ['Swairm-Step: s1', 'Swairm-Step: s1 x'],
  ['Swairm-Rung: standard', 'Swairm-Rung:'],
  ['Swairm-Proof: passed', 'Swairm-Proof: inconnu'],
])('valeur refusée : %s → %s', (avant, apres) => {
  expect(parseTrailers(`titre\n\n${bloc.replace(avant, apres)}`)).toBeNull();
});

test('drone vide, espace, continuation et caractère de contrôle refusés', () => {
  for (const drone of ['', 'deux mots', 'a\tb', 'a\x00b', 'a\nb'])
    expect(parseTrailers(`titre\n\n${bloc}\nSwairm-Drone: ${drone}`)).toBeNull();
});
