import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { StructuralService } from '../src/daemon/structural/service.js';
import { StructuralUnavailable } from '../src/shared/structural.js';

const FAKE = join(import.meta.dirname, 'fixtures/fake-codegraph.sh');
const tmp = () => mkdtempSync(join(tmpdir(), 'aid-ss-'));

afterEach(() => {
  delete process.env.FAKE_CODEGRAPH_FIXTURES;
});

test('engine off : detect faux, status unavailable, aucune requête ne lève autre chose que StructuralUnavailable', async () => {
  const service = new StructuralService({ engine: 'off' });
  const root = tmp();
  expect(service.detect(root)).toBe(false);
  expect(service.bin).toBeNull();
  const status = await service.status(root);
  expect(status).toEqual({
    engine: 'off',
    state: 'unavailable',
    reason: 'index désactivé (structural.engine = off)',
    indexedAt: null,
    files: 0,
    symbols: 0,
    languages: [],
    pending: 0,
    engineVersion: null,
    builtWith: null,
    capabilities: [],
  });
  await expect(service.explore(root, 'x')).rejects.toThrow(StructuralUnavailable);
  await expect(service.symbols(root, 'x')).rejects.toThrow(StructuralUnavailable);
  await expect(service.callers(root, 'x')).rejects.toThrow(StructuralUnavailable);
  await expect(service.impact(root, 'x')).rejects.toThrow(StructuralUnavailable);
  await expect(service.affected(root, ['a.ts'])).rejects.toThrow(StructuralUnavailable);
});

test('engine codegraph : expose le binaire configuré', () => {
  const service = new StructuralService({ engine: 'codegraph', bin: FAKE });
  expect(service.bin).toBe(FAKE);
});

test('DO2 : exclude est transmis à l’adaptateur, pas seulement accepté par le service', async () => {
  const dir = tmp();
  process.env.FAKE_CODEGRAPH_FIXTURES = dir;
  writeFileSync(
    join(dir, 'query.json'),
    JSON.stringify([
      { node: { name: 'build', kind: 'function', filePath: 'dist/index.js', startLine: 1 } },
    ]),
  );
  const service = new StructuralService({ engine: 'codegraph', bin: FAKE, exclude: ['dist'] });
  expect(await service.symbols(dir, 'build')).toEqual([]);
});

test('status est mis en cache 30 s par chemin (DS7)', async () => {
  const service = new StructuralService({ engine: 'codegraph', bin: FAKE });
  const dir = tmp();
  process.env.FAKE_CODEGRAPH_FIXTURES = dir;
  writeFileSync(
    join(dir, 'status.json'),
    JSON.stringify({ initialized: true, pendingChanges: { added: 0, modified: 0, removed: 0 } }),
  );
  const first = await service.status(dir);
  expect(first.state).toBe('ready');
  // Changement sur disque après le premier appel : un second appel immédiat ne doit pas le voir.
  writeFileSync(
    join(dir, 'status.json'),
    JSON.stringify({ initialized: true, pendingChanges: { added: 0, modified: 5, removed: 0 } }),
  );
  const second = await service.status(dir);
  expect(second.state).toBe('ready');
  expect(second).toBe(first);
});
