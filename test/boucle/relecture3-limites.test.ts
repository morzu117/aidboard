// @vitest-environment jsdom
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import { createElement, type ComponentType } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { runDoctor, type Probes } from '../../src/cli/commands/doctor.js';
import { resolvePaths } from '../../src/daemon/paths.js';
import type { ServiceBoucle } from '../../src/daemon/boucle/service.js';
import { commitFile, makeOriginAndClone } from '../helpers/git.js';

const projection: ReturnType<ServiceBoucle['lire']> = {
  phase: 'attente_go',
  plan: 'Plan fictif.',
  etapeCourante: null,
  historique: [],
  escalade: null,
  mesures: { interventionsHumaines: 0, redevs: 0, tempsParEtapeMs: {} },
};

vi.mock('../../web/src/data/useAidState.js', () => {
  const client = { request: async () => projection };
  return { useAidClient: () => client };
});
vi.mock('../../web/src/ui/AttenteConfirmation.js', () => ({
  useConfirmation: () => ({ attente: null }),
}));

const sondes: Probes = {
  nodeVersion: 'v22.23.3',
  platform: 'darwin',
  procVersion: null,
  has: () => true,
  version: async () => 'git version 2.54.0',
  loadPty: async () => null,
  loadSqlite: async () => null,
  homeMode: () => 0o40700,
  port: async () => ({ port: 4870, state: 'libre' }),
  artefactsPort: async () => ({ port: 4881, state: 'libre' }),
  claudeHooks: () => true,
  memoryHealth: async () => null,
  mcpRegistration: () => false,
  structural: async () => null,
  install: () => ({ mode: 'repo', version: null }),
  mesh: async () => null,
  swairm: async () => null,
  modeHost: async () => null,
};

const limiteMemoire = /m[ée]moire[^.]*autres projets[^.]*(?:hors|(?:pas|non) surveill)/i;

let dossier: string;

beforeEach(() => {
  dossier = mkdtempSync(join(tmpdir(), 'aid-relecture3-limites-'));
  const home = join(dossier, 'home');
  mkdirSync(home);
  vi.stubEnv('HOME', home);
  vi.stubEnv('AID_HOME', join(dossier, 'aid-home'));
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  rmSync(dossier, { recursive: true, force: true });
});

test('aid doctor expose la limite sur la mémoire des autres projets', async () => {
  const { clone } = makeOriginAndClone(dossier);
  commitFile(clone, 'agent.yml', 'phases: [plan, dev, review]\ngates: { gate: "exit 0" }\n');
  const courant = process.cwd();
  const sortie: string[] = [];
  try {
    process.chdir(clone);
    const code = await runDoctor(resolvePaths(join(dossier, 'aid-home')), sondes, (ligne) => {
      sortie.push(ligne);
    });
    expect(code).toBe(0);
  } finally {
    process.chdir(courant);
  }
  expect(sortie.join('\n')).toMatch(limiteMemoire);
});

test('la vue Boucle expose la limite sur la mémoire des autres projets avant le GO', async () => {
  // Le tsconfig daemon inclut ce fichier sans activer JSX.
  const moduleVue = '../../web/src/ecrans/Boucle.tsx';
  const { Boucle } = (await import(moduleVue)) as { Boucle: ComponentType<{ sujetId: string }> };
  render(createElement(Boucle, { sujetId: 'tp_1' }));
  await screen.findByRole('heading', { name: 'En attente du GO' });
  expect(screen.getByRole('region', { name: 'Boucle' }).textContent).toMatch(limiteMemoire);
});
