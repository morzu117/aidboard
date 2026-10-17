import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, describe, expect, test } from 'vitest';
import { startTestDaemon, type TestDaemon } from './helpers/daemon.js';

const CLI = join(import.meta.dirname, '../dist/cli/aid.js');
const built = existsSync(CLI);
const FAKE_CODEGRAPH = join(import.meta.dirname, 'fixtures/fake-codegraph.sh');

const INDEX_TOOLS = [
  'index_affected',
  'index_callers',
  'index_explore',
  'index_impact',
  'index_status',
  'index_symbols',
];

let t: TestDaemon | undefined;
let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
  await t?.d.stop();
  t = undefined;
  delete process.env.FAKE_CODEGRAPH_FIXTURES;
});

// `status` du faux binaire ne répond « ready » que si on lui fournit ce fichier canné
// (même fixture que test/structural-service.test.ts et test/structural-routes.test.ts). Le
// binaire est spawné par le daemon (ce process, pas le sous-processus MCP) : la variable
// doit donc être posée sur `process.env` avant `startTestDaemon`, pas transmise au client.
function fakeStatusFixtures(): void {
  const dir = mkdtempSync(join(tmpdir(), 'aid-mcp-fx-'));
  writeFileSync(
    join(dir, 'status.json'),
    JSON.stringify({ initialized: true, pendingChanges: { added: 0, modified: 0, removed: 0 } }),
  );
  process.env.FAKE_CODEGRAPH_FIXTURES = dir;
}

function seedWorkspace(t: TestDaemon, root = mkdtempSync(join(tmpdir(), 'aid-mcp-ws-'))): void {
  t.db
    .prepare(
      "INSERT INTO workspaces (id, name, root, base_branch, worktrees_dir, created_at) VALUES ('ws_1','a',?,'main','/w','t0')",
    )
    .run(root);
}

async function connect(env: Record<string, string>): Promise<Client> {
  const home = mkdtempSync(join(tmpdir(), 'aid-mcp-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, 'mcp'],
    env: { ...(process.env as Record<string, string>), AID_HOME: home, ...env },
    stderr: 'pipe',
  });
  client = new Client({ name: 'test', version: '1' });
  await client.connect(transport);
  return client;
}

type Result = { content: Array<{ type: string; text: string }>; isError?: boolean };
const text = (r: unknown) => (r as Result).content[0]!.text;

describe.skipIf(!built)('aid mcp en sous-processus', () => {
  test('tools/list rend sous « aid » les quatre memory_* et les six index_* ; put, get, list, search, conflit', async () => {
    t = await startTestDaemon();
    const c = await connect({
      AID_URL: `http://127.0.0.1:${t.d.port}`,
      AID_TOKEN: t.d.auth.adminToken,
    });
    const tools = await c.listTools();
    expect(tools.tools.map((x) => x.name).sort()).toEqual([
      ...INDEX_TOOLS,
      'memory_get',
      'memory_list',
      'memory_put',
      'memory_search',
    ]);
    expect(tools.tools.find((x) => x.name === 'memory_put')?.description).toContain('se complète');

    const put = await c.callTool({
      name: 'memory_put',
      arguments: { slug: 'aid/plan/alpha', text: '# Alpha\n\nun plan', title: 'Alpha' },
    });
    expect(put.isError).toBeFalsy();
    expect(JSON.parse(text(put))).toEqual({ slug: 'aid/plan/alpha', revision: 1 });

    const again = await c.callTool({
      name: 'memory_put',
      arguments: { slug: 'aid/plan/alpha', text: 'écrase' },
    });
    expect(again.isError).toBe(true);
    expect(text(again)).toContain('revision_conflict');
    expect(text(again)).toContain('révision 1');

    const app = await c.callTool({
      name: 'memory_put',
      arguments: { slug: 'aid/plan/alpha', text: '## Point 2', mode: 'append' },
    });
    expect(JSON.parse(text(app)).revision).toBe(2);
    const rep = await c.callTool({
      name: 'memory_put',
      arguments: { slug: 'aid/plan/alpha', text: 'x', expectedRevision: 1 },
    });
    expect(rep.isError).toBe(true);

    const get = await c.callTool({ name: 'memory_get', arguments: { slug: 'aid/plan/alpha' } });
    expect(text(get)).toBe('---\ntitle: Alpha\n---\n\n# Alpha\n\nun plan\n\n## Point 2\n');
    const absent = await c.callTool({ name: 'memory_get', arguments: { slug: 'aid/plan/zzz' } });
    expect(absent.isError).toBe(true);
    expect(text(absent)).toBe('page absente');

    const list = await c.callTool({ name: 'memory_list', arguments: { prefix: 'aid/' } });
    expect(JSON.parse(text(list))).toEqual({ slugs: ['aid/plan/alpha'] });
    const search = await c.callTool({
      name: 'memory_search',
      arguments: { query: 'plan', scope: 'aid', limit: 5 },
    });
    expect(JSON.parse(text(search))).toMatchObject({
      mode: 'fts',
      hits: [{ slug: 'aid/plan/alpha' }],
    });
  }, 30_000);

  test('daemon injoignable : erreur d’outil, le serveur MCP survit', async () => {
    const c = await connect({ AID_URL: 'http://127.0.0.1:1', AID_TOKEN: 'x' });
    const r = await c.callTool({ name: 'memory_get', arguments: { slug: 'aid/plan/x' } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('daemon injoignable');
    expect((await c.listTools()).tools).toHaveLength(10);
  }, 30_000);

  test('index_status sur faux binaire : admin sans sujet retombe sur le premier workspace', async () => {
    fakeStatusFixtures();
    t = await startTestDaemon(undefined, { codegraphBin: FAKE_CODEGRAPH });
    seedWorkspace(t);
    const c = await connect({
      AID_URL: `http://127.0.0.1:${t.d.port}`,
      AID_TOKEN: t.d.auth.adminToken,
    });
    const r = await c.callTool({ name: 'index_status', arguments: {} });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(text(r))).toMatchObject({ engine: 'codegraph', state: 'ready' });
  }, 30_000);

  test('moteur off : isError au texte exact « index indisponible : lecture directe »', async () => {
    t = await startTestDaemon(undefined, { structuralEngine: 'off' });
    seedWorkspace(t);
    const c = await connect({
      AID_URL: `http://127.0.0.1:${t.d.port}`,
      AID_TOKEN: t.d.auth.adminToken,
    });
    const r = await c.callTool({ name: 'index_status', arguments: {} });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe('index indisponible : lecture directe');
  }, 30_000);
});
