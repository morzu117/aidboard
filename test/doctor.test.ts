import { expect, test } from 'vitest';
import {
  gitAtLeast,
  nodeSupported,
  type Probes,
  runChecks,
  runDoctor,
} from '../src/cli/commands/doctor.js';
import { resolvePaths } from '../src/daemon/paths.js';

const good: Probes = {
  nodeVersion: 'v22.23.3',
  platform: 'darwin',
  procVersion: null,
  has: () => true,
  version: async () => 'git version 2.54.0',
  loadPty: async () => null,
  loadSqlite: async () => null,
  homeMode: () => 0o40700,
  port: async () => ({ port: 4870, state: 'libre' }),
};

const levels = async (over: Partial<Probes>) =>
  (await runChecks({ ...good, ...over })).map((c) => `${c.level}:${c.label}`);

test('une machine saine : aucun ⚠ ni ✗', async () => {
  const checks = await runChecks(good);
  expect(checks.filter((c) => c.level !== 'ok')).toEqual([]);
});

test('versions de node prises en charge', () => {
  for (const v of ['v22.12.0', 'v22.23.3', 'v24.21.0']) expect(nodeSupported(v), v).toBe(true);
  for (const v of ['v20.19.0', 'v22.11.0', 'v25.0.0']) expect(nodeSupported(v), v).toBe(false);
});

test('git : seuil 2.38', () => {
  expect(gitAtLeast('git version 2.54.0 (Apple Git-157)', 2, 38)).toBe(true);
  expect(gitAtLeast('git version 2.34.1', 2, 38)).toBe(false);
  expect(gitAtLeast('inconnu', 2, 38)).toBe(true);
});

test('node hors plage, node-pty ou sqlite cassés, git ou bash absents : ✗', async () => {
  expect(await levels({ nodeVersion: 'v20.1.0' })).toContain('ko:node v20.1.0');
  expect(await levels({ loadPty: async () => 'posix_spawnp failed' })).toContain('ko:node-pty');
  expect(await levels({ loadSqlite: async () => 'bindings introuvables' })).toContain(
    'ko:better-sqlite3',
  );
  expect(await levels({ version: async () => null })).toContain('ko:git');
  expect(await levels({ has: (b) => b !== 'bash' })).toContain('ko:bash');
});

test('node-pty en échec sous Linux : le message nomme build-essential et python3', async () => {
  const checks = await runChecks({ ...good, platform: 'linux', loadPty: async () => 'gyp ERR!' });
  const ko = checks.find((c) => c.label === 'node-pty')!;
  expect(ko.detail).toContain('build-essential');
  expect(ko.detail).toContain('python3');
});

test('claude, codex, codegraph et gh absents : ⚠ seulement, avec leur conséquence', async () => {
  const checks = await runChecks({ ...good, has: (b) => b === 'bash' });
  const warns = checks.filter((c) => c.level === 'warn');
  expect(warns.map((c) => c.label)).toEqual([
    'claude introuvable',
    'codex introuvable',
    'codegraph introuvable',
    'gh introuvable',
  ]);
  expect(warns.find((c) => c.label.startsWith('codegraph'))?.detail).toContain('lecture directe');
  expect(checks.some((c) => c.level === 'ko')).toBe(false);
});

test('~/.aid autre que 0700 : ✗ ; absent : rien à dire', async () => {
  expect(await levels({ homeMode: () => 0o40755 })).toContain('ko:~/.aid en 755');
  expect((await levels({ homeMode: () => null })).some((l) => l.includes('~/.aid'))).toBe(false);
});

test('port : libre, occupé par un autre programme (✗), ou déjà A-I-D (✓)', async () => {
  expect(await levels({ port: async () => ({ port: 4870, state: 'occupe' }) })).toContain(
    'ko:port 4870 occupé',
  );
  expect(await levels({ port: async () => ({ port: 4870, state: 'aid' }) })).toContain(
    'ok:port 4870 : le daemon A-I-D tourne',
  );
});

test('WSL2 : wslview absent est un ⚠ ; hors WSL2 on n’en parle pas', async () => {
  const wsl = {
    procVersion: 'Linux version 5.15.0-microsoft-standard-WSL2',
    platform: 'linux' as const,
  };
  expect(await levels({ ...wsl, has: (b) => b !== 'wslview' })).toContain(
    'warn:wslview introuvable',
  );
  expect((await levels({ has: (b) => b !== 'wslview' })).some((l) => l.includes('wslview'))).toBe(
    false,
  );
});

test('runDoctor : code 1 s’il y a un ✗, 0 sinon, et une ligne par contrôle', async () => {
  const lines: string[] = [];
  expect(await runDoctor(resolvePaths('/tmp/x'), good, (s) => lines.push(s))).toBe(0);
  expect(lines[0]).toMatch(/^aidboard \d/);
  expect(lines.some((l) => l.includes('✓ node v22'))).toBe(true);
  expect(
    await runDoctor(resolvePaths('/tmp/x'), { ...good, loadPty: async () => 'x' }, () => undefined),
  ).toBe(1);
});
