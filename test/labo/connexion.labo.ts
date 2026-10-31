import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import type { Server, ServerTest } from '../../src/shared/model.js';
import { startTestDaemon, type TestDaemon, waitFor } from '../helpers/daemon.js';
import { type Alias, COMPTES, demarrerLabo, type Labo } from './labo.js';

/** Chantier 18, L.1 : le test de connexion du daemon contre un vrai sshd, pour chaque shell de connexion. */
let labo: Labo;
beforeAll(() => {
  labo = demarrerLabo();
});
afterAll(() => labo?.arreter());

let t: TestDaemon | undefined;
afterEach(async () => {
  await t?.d.stop();
  t = undefined;
});

const req = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
  t!.d.app.inject({ method, url, headers: t!.headers, payload: payload as never });

async function tester(alias: Alias, shell: string): Promise<ServerTest> {
  t = await startTestDaemon(undefined, { remote: labo.transport });
  const r = await req('POST', '/api/servers', {
    name: alias,
    mode: 'ssh_alias',
    target: alias,
    shell,
  });
  expect(r.statusCode).toBe(201);
  const s = r.json<Server>();
  const recus: ServerTest[] = [];
  t.store.on('ephemeral', (m: { type: string; test?: ServerTest }) => {
    if (m.type === 'server.test' && m.test) recus.push(structuredClone(m.test));
  });
  expect((await req('POST', `/api/servers/${s.id}/test`)).statusCode).toBe(202);
  return waitFor(() => recus.find((x) => x.finishedAt), 30_000, 'fin du test de connexion');
}

test.each([
  ['aid-labo', 'bash'],
  ['aid-labo-zsh', 'zsh'],
  ['aid-labo-dash', 'sh'],
  // le shell configuré n'est pas celui du compte : la commande passe par zsh puis bash
  ['aid-labo-zsh', 'bash'],
] as const)(
  'test de connexion complet sur %s (shell %s) : toutes les étapes vertes',
  async (alias, shell) => {
    const fini = await tester(alias, shell);
    expect(fini, fini.raw).toMatchObject({ ok: true, error: null });
    expect(fini.steps.map((s) => [s.id, s.state])).toEqual([
      ['command', 'ok'],
      ['shell', 'ok'],
      ['workdir', 'ok'],
      ['agents', 'ok'],
      ['session', 'ok'],
    ]);
    expect(fini.steps.find((s) => s.id === 'workdir')!.detail).toBe(COMPTES[alias].home);
    expect(fini.steps.find((s) => s.id === 'agents')!.detail).toBe('claude · codex');
    expect(fini.steps.find((s) => s.id === 'session')!.detail).toBe('tmux');
  },
);
