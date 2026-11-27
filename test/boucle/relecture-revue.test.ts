import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { messageEtape } from '../../src/daemon/boucle/messages.js';
import { lireRevue } from '../../src/daemon/boucle/revue.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'aid-relecture-revue-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('AID_HOME', join(home, 'aid-home'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

test('un verdict complet avec un bloc JSON non clôturé reste invalide', () => {
  const tete = 'a'.repeat(40);
  const attendu = { tete, fichiers: ['note.md'], points: ['69.8'] };
  const json = JSON.stringify({
    tete,
    verdicts: { fichiers: { 'note.md': 'pass' }, points: { '69.8': 'pass' } },
    findings: [],
  });
  const ouvert = ['```json', json].join('\n');

  expect(lireRevue(ouvert + '\n```', attendu).ok).toBe(true);
  expect(lireRevue(ouvert, attendu).ok).toBe(false);
});

test.each([
  ['simple', 'Début du journal\nFin du journal'],
  ['avec clôture interne', 'Début du journal\n```\nFin du journal'],
])('le journal de gate %s est entièrement dans un bloc clôturé', (_, rapportGate) => {
  const message = messageEtape('review', {
    plan: 'Plan fictif.',
    empreintePlan: 'exemple',
    rapportGate,
    diff: 'Diff fictif.',
  });
  const lignes = message.split('\n');
  const debut = lignes.findIndex((ligne) => ligne.startsWith('Rapport du gate'));
  expect(debut).toBeGreaterThanOrEqual(0);
  const bloc = lignes
    .slice(debut + 1)
    .join('\n')
    .trimStart()
    .split('\n');
  const ouverture = /^(`{3,}|~{3,})[^\n]*$/.exec(bloc[0] ?? '');
  expect(ouverture, 'ouverture du bloc du journal').not.toBeNull();
  const marque = ouverture![1]!;
  const fin = bloc.findIndex(
    (ligne, i) =>
      i > 0 &&
      ligne.trim().startsWith(marque) &&
      ligne
        .trim()
        .split('')
        .every((caractere) => caractere === marque[0]),
  );
  expect(fin, 'première clôture du bloc du journal').toBeGreaterThan(0);
  expect(bloc.slice(1, fin).join('\n')).toBe(rapportGate);
});
