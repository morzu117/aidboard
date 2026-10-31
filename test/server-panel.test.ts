import { afterEach, expect, test } from 'vitest';
import type { Server } from '../src/shared/model.js';
import { startTestDaemon, type TestDaemon } from './helpers/daemon.js';

// Chantier 17 (F.3) : le panneau Fichiers / Git de l'écran Discussion, ouvert ou fermé et onglet, par serveur.

let t: TestDaemon | undefined;
afterEach(async () => {
  await t?.d.stop();
  t = undefined;
});

const req = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
  t!.d.app.inject({ method, url, headers: t!.headers, payload: payload as never });

const creer = async (name: string) =>
  (await req('POST', '/api/servers', { name, mode: 'ssh_alias', target: name })).json<Server>();

test('fermé sur Fichiers par défaut, puis mémorisé par serveur', async () => {
  t = await startTestDaemon();
  const a = await creer('vps-a');
  const b = await creer('vps-b');
  expect((await req('GET', `/api/servers/${a.id}/panel`)).json()).toEqual({
    open: false,
    tab: 'files',
  });

  const r = await req('PUT', `/api/servers/${a.id}/panel`, { open: true, tab: 'git' });
  expect(r.statusCode).toBe(200);
  expect(r.json()).toEqual({ open: true, tab: 'git' });
  expect((await req('GET', `/api/servers/${a.id}/panel`)).json()).toEqual({
    open: true,
    tab: 'git',
  });
  // l'autre serveur garde son propre réglage
  expect((await req('GET', `/api/servers/${b.id}/panel`)).json()).toEqual({
    open: false,
    tab: 'files',
  });

  await req('PUT', `/api/servers/${a.id}/panel`, { open: false, tab: 'git' });
  expect((await req('GET', `/api/servers/${a.id}/panel`)).json()).toEqual({
    open: false,
    tab: 'git',
  });
});

test('corps validé, serveur inconnu en 404', async () => {
  t = await startTestDaemon();
  const a = await creer('vps-a');
  for (const body of [
    { open: true },
    { open: 'oui', tab: 'files' },
    { open: true, tab: 'terminal' },
    { open: true, tab: 'files', extra: 1 },
  ])
    expect((await req('PUT', `/api/servers/${a.id}/panel`, body)).statusCode).toBe(400);
  expect((await req('GET', `/api/servers/${a.id}/panel`)).json()).toEqual({
    open: false,
    tab: 'files',
  });

  expect((await req('GET', '/api/servers/srv_nope/panel')).statusCode).toBe(404);
  expect(
    (await req('PUT', '/api/servers/srv_nope/panel', { open: true, tab: 'files' })).statusCode,
  ).toBe(404);
});

test('la suppression du serveur emporte son réglage de panneau', async () => {
  t = await startTestDaemon();
  const a = await creer('vps-a');
  const b = await creer('vps-b');
  await req('PUT', `/api/servers/${a.id}/panel`, { open: true, tab: 'git' });
  await req('PUT', `/api/servers/${b.id}/panel`, { open: true, tab: 'git' });
  expect((await req('DELETE', `/api/servers/${a.id}`)).statusCode).toBe(204);

  const cles = (
    t.d.db.prepare('SELECT key FROM nav_pref ORDER BY key').all() as { key: string }[]
  ).map((r) => r.key);
  expect(cles).not.toContain(`serveur.panneau.${a.id}`);
  expect(cles).toContain(`serveur.panneau.${b.id}`);
});

test('valeur stockée illisible : défaut plutôt qu’une erreur', async () => {
  t = await startTestDaemon();
  const a = await creer('vps-a');
  t.d.db
    .prepare('INSERT INTO nav_pref (key, value) VALUES (?, ?)')
    .run(`serveur.panneau.${a.id}`, '{pas du json');
  expect((await req('GET', `/api/servers/${a.id}/panel`)).json()).toEqual({
    open: false,
    tab: 'files',
  });
});
