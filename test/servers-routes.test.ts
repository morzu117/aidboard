import { afterEach, expect, test } from 'vitest';
import type { Server } from '../src/shared/model.js';
import { issueRunToken } from '../src/daemon/security.js';
import { startTestDaemon, type TestDaemon } from './helpers/daemon.js';

let t: TestDaemon | undefined;
afterEach(async () => {
  await t?.d.stop();
  t = undefined;
});

const req = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  t!.d.app.inject({ method, url, headers: t!.headers, payload: payload as never });

const VPS = { name: 'vps-ovh', mode: 'ssh_alias', target: 'vps' };

test('création : défauts du brief §11.2, lecture, liste', async () => {
  t = await startTestDaemon();
  expect((await req('GET', '/api/servers')).json()).toEqual([]);

  const r = await req('POST', '/api/servers', VPS);
  expect(r.statusCode).toBe(201);
  const s = r.json<Server>();
  expect(s.id).toMatch(/^srv_/);
  expect(s).toMatchObject({
    name: 'vps-ovh',
    mode: 'ssh_alias',
    target: 'vps',
    sshOptions: null,
    loadProfile: true,
    workdir: '~',
    shell: 'bash',
    keepSession: true,
    permissionMode: 'default',
    confirmDestructive: true,
    allowedDirs: ['~'],
    groupName: 'Serveurs',
    detectedAgents: null,
    lastTestAt: null,
    rules: [],
  });
  expect(s.color).toMatch(/^#[0-9a-f]{6}$/i);

  expect((await req('GET', `/api/servers/${s.id}`)).json()).toEqual(s);
  expect((await req('GET', '/api/servers')).json()).toEqual([s]);
  expect((await req('GET', '/api/servers/srv_nope')).statusCode).toBe(404);
});

test('nom obligatoire et unique sans casse, à la création comme au renommage', async () => {
  t = await startTestDaemon();
  const a = (await req('POST', '/api/servers', VPS)).json<Server>();
  expect((await req('POST', '/api/servers', { ...VPS, name: '   ' })).statusCode).toBe(400);
  expect((await req('POST', '/api/servers', { ...VPS, name: 'VPS-OVH' })).statusCode).toBe(409);
  const b = (await req('POST', '/api/servers', { ...VPS, name: 'agents' })).json<Server>();
  expect((await req('PATCH', `/api/servers/${b.id}`, { name: 'vps-ovh' })).statusCode).toBe(409);
  // se renommer soi-même (casse comprise) est permis
  const r = await req('PATCH', `/api/servers/${a.id}`, { name: 'VPS-OVH' });
  expect(r.statusCode).toBe(200);
  expect(r.json<Server>().name).toBe('VPS-OVH');
});

test('cible SSH : jamais une option déguisée ni un caractère de contrôle (D72)', async () => {
  t = await startTestDaemon();
  for (const target of ['-oProxyCommand=touch /tmp/x', 'vps host', 'vps\nrm', '', 'a;b']) {
    const r = await req('POST', '/api/servers', { ...VPS, target });
    expect(r.statusCode, target).toBe(400);
  }
  expect(
    (await req('POST', '/api/servers', { ...VPS, target: 'debian@vps.example:22' })).statusCode,
  ).toBe(201);
  // en mode commande locale, la cible est une commande : espaces permis, contrôles refusés
  const cmd = await req('POST', '/api/servers', {
    name: 'cmd',
    mode: 'command',
    target: 'ssh vps',
  });
  expect(cmd.statusCode).toBe(201);
  expect(
    (await req('POST', '/api/servers', { name: 'c2', mode: 'command', target: 'ssh\nvps' }))
      .statusCode,
  ).toBe(400);
  expect(
    (await req('POST', '/api/servers', { ...VPS, name: 'm', mode: 'telnet' })).statusCode,
  ).toBe(400);
});

test('hôte SSH : options validées, ignorées hors de ce mode', async () => {
  t = await startTestDaemon();
  const sshOptions = { port: 2222, user: 'debian', identityFile: '~/.ssh/id_ovh', jump: 'bastion' };
  const ok = await req('POST', '/api/servers', {
    name: 'h',
    mode: 'ssh_host',
    target: '203.0.113.10',
    sshOptions,
  });
  expect(ok.statusCode).toBe(201);
  expect(ok.json<Server>().sshOptions).toEqual(sshOptions);

  const bad = (o: Partial<typeof sshOptions>) =>
    req('POST', '/api/servers', {
      name: 'x',
      mode: 'ssh_host',
      target: 'h',
      sshOptions: { ...sshOptions, ...o },
    });
  expect((await bad({ port: 0 })).statusCode).toBe(400);
  expect((await bad({ port: 70000 })).statusCode).toBe(400);
  expect((await bad({ user: '-l root' })).statusCode).toBe(400);
  expect((await bad({ jump: '-J x' })).statusCode).toBe(400);
  expect((await bad({ identityFile: '-i' })).statusCode).toBe(400);

  const alias = await req('POST', '/api/servers', { ...VPS, sshOptions });
  expect(alias.json<Server>().sshOptions).toBeNull();
});

test('environnement, permissions et identité : validés, dossiers autorisés dédoublonnés', async () => {
  t = await startTestDaemon();
  const s = (await req('POST', '/api/servers', VPS)).json<Server>();
  const r = await req('PATCH', `/api/servers/${s.id}`, {
    workdir: '/srv/app',
    shell: 'zsh',
    keepSession: false,
    loadProfile: false,
    permissionMode: 'auto',
    confirmDestructive: false,
    allowedDirs: ['~', '/srv', '/srv'],
    groupName: 'Prod',
    color: '#a78bfa',
  });
  expect(r.statusCode).toBe(200);
  expect(r.json<Server>()).toMatchObject({
    workdir: '/srv/app',
    shell: 'zsh',
    keepSession: false,
    loadProfile: false,
    permissionMode: 'auto',
    confirmDestructive: false,
    allowedDirs: ['~', '/srv'],
    groupName: 'Prod',
    color: '#a78bfa',
    name: 'vps-ovh',
  });
  expect(r.json<Server>().updatedAt >= s.updatedAt).toBe(true);

  for (const body of [
    { workdir: 'relatif' },
    { allowedDirs: ['srv'] },
    { shell: 'bash; rm' },
    { permissionMode: 'bypassPermissions' },
    { color: 'rouge' },
    { groupName: ' ' },
    { inconnu: 1 },
  ]) {
    expect(
      (await req('PATCH', `/api/servers/${s.id}`, body)).statusCode,
      JSON.stringify(body),
    ).toBe(400);
  }
  expect((await req('PATCH', '/api/servers/srv_nope', { shell: 'zsh' })).statusCode).toBe(404);
});

test('suppression : le serveur et ses règles, rien d’autre ; règle révocable', async () => {
  t = await startTestDaemon();
  const s = (await req('POST', '/api/servers', VPS)).json<Server>();
  const now = new Date().toISOString();
  t.db
    .prepare('INSERT INTO server_rules (id, server_id, pattern, created_at) VALUES (?, ?, ?, ?)')
    .run('sr_1', s.id, 'systemctl restart nginx', now);
  t.db
    .prepare('INSERT INTO server_rules (id, server_id, pattern, created_at) VALUES (?, ?, ?, ?)')
    .run('sr_2', s.id, 'journalctl', now);
  expect((await req('GET', `/api/servers/${s.id}`)).json<Server>().rules.map((r) => r.id)).toEqual([
    'sr_1',
    'sr_2',
  ]);

  const revoked = await req('DELETE', `/api/servers/${s.id}/rules/sr_1`);
  expect(revoked.statusCode).toBe(200);
  expect(revoked.json<Server>().rules.map((r) => r.pattern)).toEqual(['journalctl']);
  expect((await req('DELETE', `/api/servers/${s.id}/rules/sr_1`)).statusCode).toBe(404);

  expect((await req('DELETE', `/api/servers/${s.id}`)).statusCode).toBe(204);
  expect((await req('GET', `/api/servers/${s.id}`)).statusCode).toBe(404);
  expect(t.db.prepare('SELECT COUNT(*) AS n FROM server_rules').get()).toEqual({ n: 0 });
  expect((await req('DELETE', `/api/servers/${s.id}`)).statusCode).toBe(404);
});

test('token de run : aucun accès aux serveurs', async () => {
  t = await startTestDaemon();
  const headers = {
    host: t.headers.host!,
    authorization: `Bearer ${issueRunToken(t.d.auth, 'run_1')}`,
  };
  for (const method of ['GET', 'POST'] as const) {
    const r = await t.d.app.inject({
      method,
      url: '/api/servers',
      headers,
      payload: method === 'POST' ? (VPS as never) : undefined,
    });
    expect(r.statusCode).toBe(403);
  }
  expect(
    (
      await t.d.app.inject({
        method: 'GET',
        url: '/api/servers',
        headers: { host: t.headers.host! },
      })
    ).statusCode,
  ).toBe(401);
});
