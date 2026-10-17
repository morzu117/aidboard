import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { CodegraphIndex, isExcluded } from '../src/daemon/structural/codegraph.js';
import { StructuralUnavailable } from '../src/shared/structural.js';

const FAKE = join(import.meta.dirname, 'fixtures/fake-codegraph.sh');
const FIXTURES = join(import.meta.dirname, 'fixtures/codegraph');
const tmp = () => mkdtempSync(join(tmpdir(), 'aid-si-'));

afterEach(() => {
  delete process.env.FAKE_CODEGRAPH_FIXTURES;
  delete process.env.FAKE_CODEGRAPH_SLEEP;
});

test('detect : présence de .codegraph sur le disque', () => {
  const root = tmp();
  const engine = new CodegraphIndex(FAKE);
  expect(engine.detect(root)).toBe(false);
  mkdirSync(join(root, '.codegraph'));
  expect(engine.detect(root)).toBe(true);
});

test('status sur une fixture prête : ready, langages, builtWith', async () => {
  process.env.FAKE_CODEGRAPH_FIXTURES = FIXTURES;
  const status = await new CodegraphIndex(FAKE).status(tmp());
  expect(status.engine).toBe('codegraph');
  expect(status.state).toBe('ready');
  expect(status.languages).toEqual(['typescript']);
  expect(status.builtWith).toBe('1.6.2');
  expect(status.engineVersion).toBe('1.6.2');
  expect(status.pending).toBe(0);
  expect(status.capabilities).toContain('impact');
  expect(status.capabilities).not.toContain('types');
});

test('status avec des changements en attente : stale', async () => {
  const dir = tmp();
  process.env.FAKE_CODEGRAPH_FIXTURES = dir;
  writeFileSync(
    join(dir, 'status.json'),
    JSON.stringify({
      initialized: true,
      version: '1.6.2',
      lastIndexed: '2026-10-17T08:00:00.000Z',
      fileCount: 1,
      nodeCount: 1,
      languages: ['typescript'],
      pendingChanges: { added: 0, modified: 3, removed: 0 },
      index: { builtWithVersion: '1.6.2' },
    }),
  );
  const status = await new CodegraphIndex(FAKE).status(tmp());
  expect(status.state).toBe('stale');
  expect(status.pending).toBe(3);
});

test('worktreeMismatch non nul : stale avec reason, jamais ready à tort', async () => {
  const dir = tmp();
  process.env.FAKE_CODEGRAPH_FIXTURES = dir;
  writeFileSync(
    join(dir, 'status.json'),
    JSON.stringify({
      initialized: true,
      version: '1.6.2',
      lastIndexed: '2026-10-17T08:00:00.000Z',
      fileCount: 1,
      nodeCount: 1,
      languages: ['typescript'],
      pendingChanges: { added: 0, modified: 0, removed: 0 },
      index: { builtWithVersion: '1.6.2' },
      worktreeMismatch: '/autre/chemin',
    }),
  );
  const status = await new CodegraphIndex(FAKE).status(tmp());
  expect(status.state).toBe('stale');
  expect(status.reason).toContain('worktreeMismatch');
  expect(status.reason).toContain('/autre/chemin');
});

test('worktreeMismatch null (cas normal) : ready sans reason', async () => {
  process.env.FAKE_CODEGRAPH_FIXTURES = FIXTURES;
  const status = await new CodegraphIndex(FAKE).status(tmp());
  expect(status.state).toBe('ready');
  expect(status.reason).toBeUndefined();
});

test('binaire introuvable : unavailable avec motif', async () => {
  const status = await new CodegraphIndex('/chemin/inexistant/codegraph').status(tmp());
  expect(status.state).toBe('unavailable');
  expect(status.reason).toMatch(/introuvable/);
});

test('délai dépassé : unavailable, le processus est tué', async () => {
  process.env.FAKE_CODEGRAPH_SLEEP = '2';
  const status = await new CodegraphIndex(FAKE, 100).status(tmp());
  expect(status.state).toBe('unavailable');
  expect(status.reason).toMatch(/délai/);
});

test("sortie JSON illisible : unavailable, jamais d'exception", async () => {
  const dir = tmp();
  process.env.FAKE_CODEGRAPH_FIXTURES = dir;
  writeFileSync(join(dir, 'status.json'), 'ceci n’est pas du JSON');
  const status = await new CodegraphIndex(FAKE).status(tmp());
  expect(status.state).toBe('unavailable');
});

test('index non initialisé : unavailable', async () => {
  const dir = tmp();
  process.env.FAKE_CODEGRAPH_FIXTURES = dir;
  writeFileSync(join(dir, 'status.json'), JSON.stringify({ initialized: false }));
  const status = await new CodegraphIndex(FAKE).status(tmp());
  expect(status.state).toBe('unavailable');
  expect(status.reason).toMatch(/non initialisé/);
});

test('impact rend des SymbolRef typés, provenance candidate', async () => {
  process.env.FAKE_CODEGRAPH_FIXTURES = FIXTURES;
  const { affected, provenance } = await new CodegraphIndex(FAKE).impact(tmp(), 'useExample');
  expect(provenance).toBe('candidate');
  expect(affected).toEqual([
    { name: 'useExample', kind: 'function', file: 'src/example.ts', line: 10 },
    { name: 'ExampleClient', kind: 'function', file: 'src/example-client.tsx', line: 5 },
  ]);
});

test('callers lève StructuralUnavailable sur délai dépassé, jamais un throw générique', async () => {
  process.env.FAKE_CODEGRAPH_SLEEP = '2';
  await expect(new CodegraphIndex(FAKE, 100).callers(tmp(), 'useExample')).rejects.toThrow(
    StructuralUnavailable,
  );
});

test('symbols et affected lisent les fixtures JSON', async () => {
  process.env.FAKE_CODEGRAPH_FIXTURES = FIXTURES;
  const engine = new CodegraphIndex(FAKE);
  const syms = await engine.symbols(tmp(), 'useExample');
  expect(syms).toEqual([
    { name: 'useExample', kind: 'function', file: 'src/example.ts', line: 10 },
  ]);
  const { tests } = await engine.affected(tmp(), ['src/example.ts']);
  expect(tests).toEqual(['src/example.test.ts']);
});

test('explore rend un texte, jamais parsé en JSON', async () => {
  const { text } = await new CodegraphIndex(FAKE).explore(tmp(), 'useExample');
  expect(text).toContain('Exploration');
});

test('isExcluded : un segment de chemin exact, jamais une sous-chaîne', () => {
  expect(isExcluded('apps/api/dist/index.js', ['dist'])).toBe(true);
  expect(isExcluded('src/distillery.ts', ['dist'])).toBe(false);
  expect(isExcluded('src/example.ts', [])).toBe(false);
});

test('DO2 : symbols, callers, impact et affected filtrent les fichiers sous dist/', async () => {
  const dir = tmp();
  process.env.FAKE_CODEGRAPH_FIXTURES = dir;
  writeFileSync(
    join(dir, 'query.json'),
    JSON.stringify([
      { node: { name: 'useExample', kind: 'function', filePath: 'src/example.ts', startLine: 10 } },
      {
        node: { name: 'build', kind: 'function', filePath: 'apps/api/dist/index.js', startLine: 1 },
      },
    ]),
  );
  writeFileSync(
    join(dir, 'callers.json'),
    JSON.stringify({
      callers: [
        {
          name: 'ExampleClient',
          kind: 'function',
          filePath: 'src/example-client.tsx',
          startLine: 5,
        },
        { name: 'legacy', kind: 'function', filePath: 'apps/api/dist/legacy.js', startLine: 1 },
      ],
    }),
  );
  writeFileSync(
    join(dir, 'impact.json'),
    JSON.stringify({
      affected: [
        { name: 'useExample', kind: 'function', filePath: 'src/example.ts', startLine: 10 },
        { name: 'build', kind: 'function', filePath: 'apps/api/dist/index.js', startLine: 1 },
      ],
    }),
  );
  writeFileSync(
    join(dir, 'affected.json'),
    JSON.stringify({
      affectedTests: ['src/example.test.ts', 'apps/api/dist/legacy.test.js'],
    }),
  );

  const engine = new CodegraphIndex(FAKE, undefined, ['dist']);
  expect(await engine.symbols(tmp(), 'x')).toEqual([
    { name: 'useExample', kind: 'function', file: 'src/example.ts', line: 10 },
  ]);
  const callers = await engine.callers(tmp(), 'useExample');
  expect(callers).toHaveLength(1);
  expect(callers[0]!.from.file).toBe('src/example-client.tsx');
  const { affected } = await engine.impact(tmp(), 'useExample');
  expect(affected).toEqual([
    { name: 'useExample', kind: 'function', file: 'src/example.ts', line: 10 },
  ]);
  const { tests } = await engine.affected(tmp(), ['src/example.ts']);
  expect(tests).toEqual(['src/example.test.ts']);
});
