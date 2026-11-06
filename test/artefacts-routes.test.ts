import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { EtatArtefacts, LienArtefact } from '../src/shared/artefacts.js';
import { type Ctx, makeTopic, setupWorkspace } from './helpers/topics.js';

// Chantier 30 (D162, D163, D166) : le lien est émis par le port principal, authentifié ;
// le second port, ouvert par le vrai daemon, sert le contenu lu à l'émission.

let c: Ctx;
afterEach(async () => {
  await c?.t.d.stop();
});

const lien = (topicId: string, path: string, host?: string) =>
  c.t.d.app.inject({
    method: 'POST',
    url: `/api/topics/${topicId}/artefacts/lien`,
    headers: { ...c.t.headers, ...(host && { host }) },
    payload: { path },
  });

const etat = async () =>
  (
    await c.t.d.app.inject({ url: '/api/artefacts/etat', headers: c.t.headers })
  ).json<EtatArtefacts>();

test('D162 : le daemon ouvre le second port au démarrage', async () => {
  c = await setupWorkspace();
  const e = await etat();
  expect(e.disponible).toBe(true);
  expect(e.port).toBeGreaterThan(0);
  expect(e.port).not.toBe(c.t.d.port);
});

test('D163 : un lien vers le contenu lu à l’émission, sans id de sujet ni jeton admin', async () => {
  c = await setupWorkspace();
  const t = await makeTopic(c);
  writeFileSync(join(t.wt, 'rapport.html'), '<h1>v1</h1>');
  const r = await lien(t.topicId, 'rapport.html');
  expect(r.statusCode).toBe(200);
  expect(r.headers['cache-control']).toBe('no-store');
  const { url, expireA } = r.json<LienArtefact>();
  const { port } = await etat();
  expect(url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${port}/a/[A-Za-z0-9_-]{43}$`));
  expect(url).not.toContain(t.topicId);
  expect(url).not.toContain(c.t.d.auth.adminToken);
  expect(Date.parse(expireA) - Date.now()).toBeGreaterThan(9 * 60_000);

  // le fichier change après l'émission : le lien sert toujours ce qui a été lu
  writeFileSync(join(t.wt, 'rapport.html'), '<h1>v2</h1>');
  const servi = await fetch(url);
  expect(servi.status).toBe(200);
  expect(await servi.text()).toBe('<h1>v1</h1>');
  expect(servi.headers.get('content-security-policy')).toMatch(/^sandbox allow-scripts; /);
  expect(servi.headers.get('set-cookie')).toBeNull();
  // réutilisable dans sa fenêtre
  expect((await fetch(url)).status).toBe(200);
});

test('D163 : le lien suit l’hôte de la page', async () => {
  c = await setupWorkspace();
  const t = await makeTopic(c);
  writeFileSync(join(t.wt, 'schema.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const r = await lien(t.topicId, 'schema.svg', `localhost:${c.t.d.port}`);
  expect(r.statusCode).toBe(200);
  const { url } = r.json<LienArtefact>();
  expect(url.startsWith('http://localhost:')).toBe(true);
  const servi = await fetch(url);
  expect(servi.headers.get('content-type')).toBe('image/svg+xml');
});

test('D163 : les gardes de Fichiers, et seulement le HTML et le SVG', async () => {
  c = await setupWorkspace();
  const t = await makeTopic(c);
  writeFileSync(join(t.wt, 'notes.md'), '# notes');
  writeFileSync(join(t.wt, 'donnees.txt'), 'x');
  writeFileSync(join(t.wt, 'binaire.html'), Buffer.from([0x3c, 0x00, 0x3e]));
  writeFileSync(join(t.wt, 'gros.html'), 'x'.repeat(1024 * 1024 + 1));
  const cas: Array<[string, number]> = [
    ['notes.md', 422],
    ['donnees.txt', 422],
    ['binaire.html', 422],
    ['gros.html', 422],
    ['absent.html', 404],
    ['../dehors.html', 422],
  ];
  writeFileSync(join(t.wt, '..', 'dehors.html'), '<p>hors du worktree</p>');
  for (const [path, code] of cas) {
    expect((await lien(t.topicId, path)).statusCode, path).toBe(code);
  }
  expect((await lien('tp_inconnu', 'rapport.html')).statusCode).toBe(404);
});

test('D166 : la page du cockpit n’encadre que le port des artefacts', async () => {
  c = await setupWorkspace();
  const { port } = await etat();
  const r = await c.t.d.app.inject({ url: '/api/state', headers: c.t.headers });
  const csp = String(r.headers['content-security-policy']);
  expect(csp).toContain(`frame-src http://127.0.0.1:${port} http://localhost:${port};`);
  expect(csp).toContain("frame-ancestors 'none'");
});
