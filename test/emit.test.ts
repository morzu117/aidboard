import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { emitEvent, runEmit } from '../src/cli/commands/emit.js';
import { issueRunToken } from '../src/daemon/security.js';
import { seedTopic, startTestDaemon, type TestDaemon } from './helpers/daemon.js';

let t: TestDaemon | undefined;
afterEach(async () => {
  await t?.d.stop();
  t = undefined;
  vi.restoreAllMocks();
});

const tmp = () => mkdtempSync(join(tmpdir(), 'aid-emit-'));
const statuses = (d: TestDaemon) => d.store.since(null).filter((e) => e.type === 'agent.status');

test('hors A-I-D (pas d’AID_AGENT) : rien n’est posté ni écrit, sortie en 0', async () => {
  const spool = join(tmp(), 'spool');
  const fetchImpl = vi.fn();
  expect(await emitEvent('agent.status', {}, { AID_SPOOL: spool }, { fetchImpl })).toEqual({
    outcome: 'skipped',
  });
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(await runEmit(['agent.status', '--status', 'working'], { AID_SPOOL: spool })).toBe(0);
  expect(() => readdirSync(spool)).toThrow();
});

test('daemon joignable : l’enveloppe est complétée depuis l’environnement et ingérée', async () => {
  t = await startTestDaemon();
  seedTopic(t.db);
  const env = {
    AID_URL: `http://127.0.0.1:${t.d.port}`,
    AID_TOKEN: issueRunToken(t.d.auth, 'run_1'),
    AID_RUN: 'run_1',
    AID_AGENT: 'ag_1',
    AID_SPOOL: join(tmp(), 'spool'),
  };
  const code = await runEmit(
    [
      'agent.status',
      '--status',
      'needs_input',
      '--reason',
      'permission',
      '--message',
      'Autoriser ?',
    ],
    env,
  );
  expect(code).toBe(0);
  expect(statuses(t)[0]).toMatchObject({
    source: 'hook:claude',
    topicId: 'tp_1',
    workspaceId: 'ws_1',
    agentId: 'ag_1',
    data: { status: 'needs_input', reason: 'permission', message: 'Autoriser ?' },
  });
});

test('un type réservé est refusé : sortie en 1, rien au spool', async () => {
  t = await startTestDaemon();
  seedTopic(t.db);
  const spool = join(tmp(), 'spool');
  const env = {
    AID_URL: `http://127.0.0.1:${t.d.port}`,
    AID_TOKEN: issueRunToken(t.d.auth, 'run_1'),
    AID_RUN: 'run_1',
    AID_AGENT: 'ag_1',
    AID_SPOOL: spool,
  };
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  expect(await runEmit(['topic.state', '--data', '{"state":"merged"}'], env)).toBe(1);
  expect(existsSync(spool)).toBe(false);
});

test('daemon absent : spool en 0600 dans un dossier en 0700, puis rejoué au démarrage', async () => {
  const home = tmp();
  // un premier démarrage crée la base, où l'on met le run ; puis le daemon s'arrête
  t = await startTestDaemon(home);
  seedTopic(t.db);
  await t.d.stop();
  const spool = join(home, 'spool');
  const env = {
    AID_URL: 'http://127.0.0.1:9', // rien n'écoute
    AID_TOKEN: 'périmé',
    AID_RUN: 'run_1',
    AID_AGENT: 'ag_1',
    AID_SPOOL: spool,
  };
  expect((await emitEvent('agent.tool', { label: 'Bash(npm test)' }, env)).outcome).toBe('spooled');
  const [file] = readdirSync(spool);
  expect(statSync(spool).mode & 0o777).toBe(0o700);
  expect(statSync(join(spool, file!)).mode & 0o777).toBe(0o600);
  const id = JSON.parse(readFileSync(join(spool, file!), 'utf8')).id as string;

  t = await startTestDaemon(home);
  const replayed = t.store.since(null).find((e) => e.id === id);
  expect(replayed).toMatchObject({ type: 'agent.tool', topicId: 'tp_1', agentId: 'ag_1' });
  expect(readdirSync(spool).filter((n) => n.endsWith('.json'))).toHaveLength(0);
});

test('rejeu : un fichier qui usurpe une source du daemon ou un run inconnu part dans rejet/', async () => {
  const home = tmp();
  t = await startTestDaemon(home);
  seedTopic(t.db);
  await t.d.stop();
  const spool = join(home, 'spool');
  mkdirSync(spool, { recursive: true });
  const base = { v: 1, ts: '2026-10-16T00:00:00Z', agentId: 'ag_1', data: {} };
  writeFileSync(
    join(spool, 'a.json'),
    JSON.stringify({ ...base, id: 'A1', source: 'daemon', type: 'topic.state', runId: 'run_1' }),
  );
  writeFileSync(
    join(spool, 'b.json'),
    JSON.stringify({ ...base, id: 'B1', source: 'hook:claude', type: 'cost', runId: 'run_x' }),
  );
  writeFileSync(join(spool, 'c.json'), '{pas du json');
  t = await startTestDaemon(home);
  expect(t.store.since(null).some((e) => e.id === 'A1' || e.id === 'B1')).toBe(false);
  expect(readdirSync(join(spool, 'rejet')).sort()).toEqual(['a.json', 'b.json', 'c.json']);
});
