import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { transition, type EtatBoucle } from '../../src/daemon/boucle/etat.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'aid-relecture3-etat-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('AID_HOME', join(home, 'aid'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

test('une tentative de revue close sans issue consigne fail', () => {
  const tete = 'a'.repeat(40);
  const avant: EtatBoucle = {
    phase: 'revue',
    acceptation: false,
    redevCap: 2,
    redevs: 0,
    tete,
    empreintePlan: null,
    gate: { tete, issue: 'pass' },
    revue: null,
    etapes: [
      {
        type: 'revue',
        tentative: 1,
        agentId: 'agent-fictif',
        debut: 100,
        echeance: 300,
        issue: null,
      },
    ],
  };
  const { etat } = transition(avant, { type: 'revue_terminee', tete }, 200);
  expect.soft(etat.revue).toEqual({ tete, issue: 'fail' });
  expect(etat.etapes[0]).toMatchObject({ issue: 'fail', fin: 200, teteArrivee: tete });
});
