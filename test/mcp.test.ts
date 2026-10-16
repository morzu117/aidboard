import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, describe, expect, test } from 'vitest';
import { startTestDaemon, type TestDaemon } from './helpers/daemon.js';

const CLI = join(import.meta.dirname, '../dist/cli/aid.js');
const built = existsSync(CLI);

let t: TestDaemon | undefined;
let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
  await t?.d.stop();
  t = undefined;
});

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
  test('tools/list rend les quatre outils ; put, get, list, search, conflit', async () => {
    t = await startTestDaemon();
    const c = await connect({
      AID_URL: `http://127.0.0.1:${t.d.port}`,
      AID_TOKEN: t.d.auth.adminToken,
    });
    const tools = await c.listTools();
    expect(tools.tools.map((x) => x.name).sort()).toEqual([
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
    expect((await c.listTools()).tools).toHaveLength(4);
  }, 30_000);
});
