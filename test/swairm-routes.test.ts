import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { issueRunToken } from '../src/daemon/security.js';
import { startTestDaemon, type TestDaemon } from './helpers/daemon.js';

let t: TestDaemon | undefined;
let dossier: string;
afterEach(async () => {
  await t?.d.stop();
  t = undefined;
  vi.unstubAllEnvs();
  if (dossier) rmSync(dossier, { recursive: true, force: true });
});
async function demarrer(mode = 'ok') {
  dossier = mkdtempSync(join(tmpdir(), 'aid-ask-routes-'));
  const log = join(dossier, 'argv');
  const copie = join(dossier, 'copie');
  vi.stubEnv('FAKE_SWAIRM_LOG', log);
  vi.stubEnv('FAKE_SWAIRM_ASK_COPY', copie);
  vi.stubEnv('FAKE_SWAIRM_ASK_MODE', mode);
  t = await startTestDaemon(undefined, {
    config: { swairm: { bin: join(import.meta.dirname, 'fixtures/fake-swairm.sh') } },
  });
  return { log, copie };
}
const demande = { question: 'Faut-il vérifier ?', n: 1, modeles: ['sonnet'] };
const envoyer = (confirmation = true, payload: object = demande) =>
  t!.d.app.inject({
    method: 'POST',
    url: '/api/swairm/ask',
    headers: { ...t!.headers, ...(confirmation ? { 'X-AID-Confirm': 'ask' } : {}) },
    payload,
  });

test('403 sans confirmation et 400 invalides : aucun processus ; lectures et état', async () => {
  const { log } = await demarrer();
  expect((await envoyer(false)).statusCode).toBe(403);
  expect((await envoyer(true, { ...demande, n: 6 })).statusCode).toBe(400);
  expect(
    (await t!.d.app.inject({ url: '/api/swairm/asks/invalide', headers: t!.headers })).statusCode,
  ).toBe(400);
  expect(existsSync(log)).toBe(false);
  expect(
    (await t!.d.app.inject({ url: '/api/swairm/ask/etat', headers: t!.headers })).json(),
  ).toEqual({ enCours: false, depuis: null, budgetUsd: 0.5 });
  expect((await envoyer()).json()).toMatchObject({ ok: true });
  for (const url of ['/api/swairm/asks', '/api/swairm/asks/20261109T071500Z-3f2a'])
    expect((await t!.d.app.inject({ url, headers: t!.headers })).json()).toMatchObject({
      ok: true,
    });
});

test('409 pendant une demande, annulation et fichier supprimé', async () => {
  const { copie, log } = await demarrer('lent');
  const resultat = envoyer().then((r) => r);
  for (let i = 0; i < 200 && !existsSync(copie + '.path'); i++)
    await new Promise((r) => setTimeout(r, 10));
  expect(existsSync(copie + '.path')).toBe(true);
  expect((await envoyer()).statusCode).toBe(409);
  expect(
    (await t!.d.app.inject({ url: '/api/swairm/ask/etat', headers: t!.headers })).json(),
  ).toMatchObject({ enCours: true });
  expect(
    (await t!.d.app.inject({ method: 'POST', url: '/api/swairm/ask/annuler', headers: t!.headers }))
      .statusCode,
  ).toBe(200);
  expect((await resultat).json()).toMatchObject({ ok: false, kind: 'annule' });
  expect(existsSync(readFileSync(copie + '.path', 'utf8'))).toBe(false);
  expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(1);
});

test('board Swairm réservé à l’admin, disponible sans configuration', async () => {
  t = await startTestDaemon();
  expect(
    (await t.d.app.inject({ url: '/api/swairm/board', headers: { host: t.headers.host! } }))
      .statusCode,
  ).toBe(401);
  const jeton = issueRunToken(t.d.auth, 'run-test');
  expect(
    (
      await t.d.app.inject({
        url: '/api/swairm/board',
        headers: { host: t.headers.host!, authorization: `Bearer ${jeton}` },
      })
    ).statusCode,
  ).toBe(403);
  const reponse = await t.d.app.inject({ url: '/api/swairm/board', headers: t.headers });
  expect(reponse.statusCode).toBe(200);
  expect(reponse.json()).toMatchObject({
    sujets: [],
    cartes: [],
    swairm: { etat: 'non-configure' },
  });
});
