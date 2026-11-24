import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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
  const lance = join(dossier, 'lance');
  const bin = join(dossier, 'bin');
  mkdirSync(bin);
  symlinkSync('/usr/bin/git', join(bin, 'git'));
  const enveloppe = JSON.stringify({
    type: 'result',
    subtype: 'success',
    result: JSON.stringify({ reponses: [{ n: 1, verdict: 'oui', justification: 'Exemple' }] }),
  });
  writeFileSync(
    join(bin, 'claude'),
    `#!/bin/sh
printf '%s' "$PWD" > "$TRACE_AVIS"
if [ "$MODE_AVIS" = lent ]; then exec /bin/sleep 60; fi
printf '%s' '${enveloppe}'
`,
    { mode: 0o700 },
  );
  vi.stubEnv('HOME', dossier);
  vi.stubEnv('PATH', bin);
  vi.stubEnv('TRACE_AVIS', lance);
  vi.stubEnv('MODE_AVIS', mode);
  vi.stubEnv('FAKE_SWAIRM_LOG', log);
  t = await startTestDaemon(join(dossier, 'aid'), {
    config: { swairm: { bin: join(import.meta.dirname, 'fixtures/fake-swairm.sh') } },
  });
  return { log, lance };
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
  const { log, lance } = await demarrer();
  expect((await envoyer(false)).statusCode).toBe(403);
  expect((await envoyer(true, { ...demande, n: 6 })).statusCode).toBe(400);
  expect(
    (await t!.d.app.inject({ url: '/api/swairm/asks/invalide', headers: t!.headers })).statusCode,
  ).toBe(400);
  expect(existsSync(lance)).toBe(false);
  expect(
    (await t!.d.app.inject({ url: '/api/swairm/ask/etat', headers: t!.headers })).json(),
  ).toEqual({ enCours: false, depuis: null, budgetUsd: 0.5 });
  const idHistorique = '20261109T071500Z-3f2a';
  const historique = join(dossier, '.swairm', 'asks');
  mkdirSync(historique, { recursive: true });
  copyFileSync(
    join(import.meta.dirname, 'fixtures', 'swairm', `show-${idHistorique}.json`),
    join(historique, `${idHistorique}.json`),
  );
  const resultat = (await envoyer()).json();
  expect(resultat).toMatchObject({
    ok: true,
    data: { avis: [{ modele_demande: 'claude:sonnet', etat: 'ok' }] },
  });
  const { id } = resultat.data;
  const archives = (await t!.d.app.inject({ url: '/api/swairm/asks', headers: t!.headers })).json();
  expect(archives.data.demandes.map((d: { id: string }) => d.id)).toEqual([id, idHistorique]);
  for (const identifiant of [id, idHistorique])
    expect(
      (
        await t!.d.app.inject({ url: `/api/swairm/asks/${identifiant}`, headers: t!.headers })
      ).json(),
    ).toMatchObject({ ok: true, data: { id: identifiant } });
  expect(existsSync(log)).toBe(false);
});

test('409 pendant une demande, annulation et répertoire de travail supprimé', async () => {
  const { lance } = await demarrer('lent');
  const resultat = envoyer();
  for (let i = 0; i < 200 && !existsSync(lance); i++) await new Promise((r) => setTimeout(r, 10));
  expect(existsSync(lance)).toBe(true);
  expect((await envoyer()).statusCode).toBe(409);
  expect(
    (await t!.d.app.inject({ url: '/api/swairm/ask/etat', headers: t!.headers })).json(),
  ).toMatchObject({ enCours: true });
  expect(
    (await t!.d.app.inject({ method: 'POST', url: '/api/swairm/ask/annuler', headers: t!.headers }))
      .statusCode,
  ).toBe(200);
  expect((await resultat).json()).toMatchObject({ ok: false, kind: 'annule' });
  expect(existsSync(readFileSync(lance, 'utf8'))).toBe(false);
  expect(existsSync(join(t!.home, 'avis'))).toBe(false);
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
