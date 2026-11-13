import { expect, test } from 'vitest';
import {
  type MeshProbe,
  type Probes,
  runChecks,
  swarphAtLeast,
} from '../src/cli/commands/doctor.js';

// 24.5 : la vue board demande swarph 0.72.40 ; en dessous, un ⚠ nommé, jamais un ✗.

const meshOk: MeshProbe = {
  cell: 'cell-aid',
  bin: 'swarph',
  cellFile: '/home/j/.config/swarph/cells/cell-aid.yaml',
  cellFileReadable: true,
  tokenExists: true,
  gateway: 'http://gateway.example.ts.net:8788',
  tailscale: 'running',
};

const probes = (swarph: string | null): Probes => ({
  nodeVersion: 'v22.23.3',
  platform: 'darwin',
  procVersion: null,
  has: () => true,
  version: async (bin) => (bin === 'swarph' ? swarph : 'git version 2.54.0'),
  loadPty: async () => null,
  loadSqlite: async () => null,
  homeMode: () => 0o40700,
  port: async () => ({ port: 4870, state: 'libre' }),
  artefactsPort: async () => ({ port: 4880, state: 'libre' }),
  claudeHooks: () => true,
  memoryHealth: async () => null,
  mcpRegistration: () => false,
  structural: async () => null,
  install: () => ({ mode: 'repo', version: null }),
  mesh: async () => meshOk,
  swairm: async () => null,
  modeHost: async () => null,
});

const swarphLines = async (v: string | null) =>
  (await runChecks(probes(v))).filter((c) => c.label.startsWith('swarph'));

test('comparaison numérique, pas lexicale', () => {
  expect(swarphAtLeast('0.72.25')).toBe(false);
  expect(swarphAtLeast('0.72.39')).toBe(false);
  expect(swarphAtLeast('0.72.40')).toBe(true);
  expect(swarphAtLeast('0.72.100')).toBe(true);
  expect(swarphAtLeast('0.73.0')).toBe(true);
  expect(swarphAtLeast('1.0.0')).toBe(true);
  expect(swarphAtLeast('swarph-cli 0.72.41')).toBe(true);
  expect(swarphAtLeast('version inconnue')).toBe(true);
});

test('0.72.25 : un ⚠ qui nomme la version demandée', async () => {
  expect(await swarphLines('0.72.25')).toEqual([
    { level: 'ok', label: 'swarph 0.72.25' },
    {
      level: 'warn',
      label: 'swarph 0.72.25 : la vue board demande 0.72.40',
      detail: 'uv tool upgrade swarph-cli',
    },
  ]);
});

test('0.72.40 et 0.73.0 passent sans ⚠', async () => {
  for (const v of ['0.72.40', '0.73.0']) {
    expect((await swarphLines(v)).filter((c) => c.level !== 'ok')).toEqual([]);
  }
});

test('version illisible : le message existant, rien de plus', async () => {
  expect(await swarphLines(null)).toEqual([
    {
      level: 'warn',
      label: 'swarph : version illisible',
      detail:
        '`swarph --version` a échoué : réinstaller (uv tool install --python 3.12 swarph-cli)',
    },
  ]);
  expect((await swarphLines('dev')).filter((c) => c.level !== 'ok')).toEqual([]);
});
