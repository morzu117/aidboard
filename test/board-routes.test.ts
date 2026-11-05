import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { DEFAULT_CONFIG } from '../src/daemon/config.js';
import { issueRunToken } from '../src/daemon/security.js';
import type { BoardCardSheet, BoardProject, BoardResult } from '../src/shared/board.js';
import { startTestDaemon, type TestDaemon } from './helpers/daemon.js';

// 24.4 (D95) : /api/board sur le faux swarph (D40), passé par la config ; ses variables par process.env,
// que MeshService transmet à swarph. Jamais de réseau.

const FAKE_SWARPH = join(import.meta.dirname, 'fixtures', 'fake-swarph.sh');
const FAKE_TAILSCALE = join(import.meta.dirname, 'fixtures', 'fake-tailscale.sh');
const BOARD = join(import.meta.dirname, 'fixtures', 'board');
const FAKE_VARS = ['FAKE_SWARPH_LOG', 'FAKE_SWARPH_BOARD', 'FAKE_SWARPH_BOARD_ERROR'] as const;

let t: TestDaemon;
const saved = Object.fromEntries(FAKE_VARS.map((k) => [k, process.env[k]]));
afterEach(async () => {
  await t?.d.stop();
  for (const k of FAKE_VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const get = (url: string) => t.d.app.inject({ url, headers: t.headers });

async function bootWithMesh() {
  const home = mkdtempSync(join(tmpdir(), 'aid-board-r-'));
  const swarphLog = join(home, 'swarph.log');
  process.env.FAKE_SWARPH_LOG = swarphLog;
  process.env.FAKE_SWARPH_BOARD = BOARD;
  const stateRoot = join(home, 'swarph_state');
  t = await startTestDaemon(home, {
    config: {
      mesh: {
        ...DEFAULT_CONFIG.mesh,
        bin: FAKE_SWARPH,
        cell: 'morzu-mac',
        gateway: 'http://mesh-gw.example.ts.net:8788',
        stateRoot,
        tailscale: { manage: false, bin: FAKE_TAILSCALE },
      },
    },
  });
  const inboxLog = join(stateRoot, 'morzu-mac', 'mesh-sidecar', 'inbox.log');
  mkdirSync(dirname(inboxLog), { recursive: true });
  writeFileSync(
    inboxLog,
    '{"id": 1, "from_node": "peer-a", "to_node": "morzu-mac", "content": "x"}\n',
  );
  const swarph = () =>
    existsSync(swarphLog) ? readFileSync(swarphLog, 'utf8').trim().split('\n').filter(Boolean) : [];
  return { swarph, inboxLog };
}

test('mesh désactivé : les routes /api/board répondent 404', async () => {
  t = await startTestDaemon();
  for (const url of [
    '/api/board/projects',
    '/api/board/projects/42/cards',
    '/api/board/cards/101',
  ]) {
    const r = await get(url);
    expect(r.statusCode).toBe(404);
    expect(r.json<{ error: string }>().error).toContain('mesh désactivé');
  }
});

test('lectures ok : projets, cartes, fiche ; journal limité à board … --json --as morzu-mac ; inbox.log intact', async () => {
  const { swarph, inboxLog } = await bootWithMesh();
  const before = readFileSync(inboxLog, 'utf8');
  const projects = (await get('/api/board/projects')).json<BoardResult<BoardProject[]>>();
  expect(projects).toMatchObject({ ok: true, schemaVersion: null, data: [{ id: 42 }] });
  const cards = await get('/api/board/projects/42/cards');
  expect(cards.statusCode).toBe(200);
  expect(cards.json<BoardResult<unknown[]>>()).toMatchObject({ ok: true });
  const sheet = (await get('/api/board/cards/102')).json<BoardCardSheet>();
  expect(sheet.card).toMatchObject({ ok: true, data: { id: 102, assignee: 'peer-b' } });
  expect(sheet.graph.ok && sheet.thread.ok && sheet.obligations.ok).toBe(true);
  const board = swarph().filter((l) => l.startsWith('board '));
  expect(board).toHaveLength(6);
  for (const l of board) expect(l).toMatch(/ --json --as morzu-mac$/);
  for (const l of swarph()) {
    expect(l).not.toMatch(/\binbox\b|--consume|--no-redact|--token-file/);
  }
  expect(readFileSync(inboxLog, 'utf8')).toBe(before);
});

test('cache de 5 s, ?fresh=1 relit', async () => {
  const { swarph } = await bootWithMesh();
  await get('/api/board/projects');
  await get('/api/board/projects');
  expect(swarph().filter((l) => l.startsWith('board projects'))).toHaveLength(1);
  await get('/api/board/projects?fresh=1');
  expect(swarph().filter((l) => l.startsWith('board projects'))).toHaveLength(2);
});

test('identifiant invalide : 400, sans lancer swarph', async () => {
  const { swarph } = await bootWithMesh();
  for (const url of [
    '/api/board/cards/abc',
    '/api/board/cards/0',
    '/api/board/cards/1.5',
    '/api/board/cards/-1',
    '/api/board/projects/x/cards',
  ]) {
    expect((await get(url)).statusCode).toBe(400);
  }
  expect(swarph().filter((l) => l.startsWith('board '))).toEqual([]);
});

test('chaque erreur de swarph : 200 et un kind, jamais le texte de stderr', async () => {
  await bootWithMesh();
  const cases = [
    ['forbidden', 'forbidden'],
    ['unreachable', 'unreachable'],
    ['credential', 'credential'],
    ['other', 'unknown'],
    ['too-old', 'too-old'],
  ] as const;
  for (const [error, kind] of cases) {
    process.env.FAKE_SWARPH_BOARD_ERROR = error;
    const r = await get('/api/board/projects?fresh=1');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: false, kind, readAt: expect.any(String) as string });
    expect(r.body).not.toContain('swarph board:');
  }
  delete process.env.FAKE_SWARPH_BOARD_ERROR;
  // carte absente des fixtures : le faux swarph répond 404 en code 1, classé not-found (D95 bis)
  const sheet = (await get('/api/board/cards/999')).json<BoardCardSheet>();
  expect(sheet.card).toMatchObject({ ok: false, kind: 'not-found' });
});

test('un token de run est refusé sur /api/board', async () => {
  await bootWithMesh();
  const token = issueRunToken(t.d.auth, 'run_board');
  const r = await t.d.app.inject({
    url: '/api/board/projects',
    headers: { host: t.headers.host!, authorization: `Bearer ${token}` },
  });
  expect(r.statusCode).toBe(403);
});
