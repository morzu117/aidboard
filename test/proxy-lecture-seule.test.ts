import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { DEFAULT_CONFIG } from '../src/daemon/config.js';
import { creerReglage } from '../src/daemon/confirmations/reglage.js';
import { startTestDaemon, waitFor, type TestDaemon } from './helpers/daemon.js';

let t: TestDaemon | undefined;
afterEach(async () => {
  if (!t) return;
  await t.d.stop();
  rmSync(t.home, { recursive: true, force: true });
  t = undefined;
});

async function preparer(proxy: boolean, lectureSeule: boolean) {
  const home = mkdtempSync(join(tmpdir(), 'aid-lecture-seule-'));
  t = await startTestDaemon(home, {
    config: {
      mesh: {
        ...DEFAULT_CONFIG.mesh,
        cell: 'peer-a',
        bin: join(import.meta.dirname, 'fixtures/fake-swarph.sh'),
        proxySocket: proxy ? join(home, 'proxy.sock') : '',
        inboxLog: proxy ? join(home, 'inbox.log') : '',
        proxyLectureSeule: lectureSeule,
      },
    },
  });
  await waitFor(() => t!.store.since(null).some((e) => e.type === 'mesh.state'));
  return t;
}

test.each([
  [false, false, false],
  [false, true, false],
  [true, false, true],
  [true, true, false],
])('D283 : état publié proxy=%s lecture seule=%s', async (proxy, lectureSeule, ecritures) => {
  const t = await preparer(proxy, lectureSeule);
  for (const url of ['/api/mesh', '/api/state']) {
    const r = await t.d.app.inject({ url, headers: t.headers });
    expect(r.statusCode).toBe(200);
    const etat = url === '/api/mesh' ? r.json().state : r.json().mesh.state;
    expect(etat).toMatchObject({ ecritures, proxyConfigure: proxy });
    expect(r.body).not.toContain(join(t.home, 'proxy.sock'));
    expect(r.body).not.toContain('proxySocket');
    expect(r.body).not.toContain('inboxLog');
  }
  const evenements = t.store.since(null).filter((e) => e.type === 'mesh.state');
  expect(evenements.length).toBeGreaterThan(0);
  expect(evenements.at(-1)?.data).toMatchObject({ ecritures, proxyConfigure: proxy });
});

test('D283 : les deux routes refusent avant la porte, aucune demande, aperçu disponible', async () => {
  const t = await preparer(true, true);
  creerReglage(t.db).armer();
  const compter = () => t.db.prepare('SELECT COUNT(*) AS n FROM pda_demandes').get();
  const avant = compter();
  for (const [route, action, params] of [
    ['ecrire', 'dm.envoyer', { pair: 'peer-b', fil: null, kind: 'fyi', texte: 'Bonjour' }],
    ['etat', 'obligation.prendre', { carte: 42, obligation: 81, attendu: { status: 'open' } }],
  ] as const) {
    const r = await t.d.app.inject({
      method: 'POST',
      url: `/api/swarph/${route}/envoyer`,
      headers: t.headers,
      payload: { action, params },
    });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: 'proxy_lecture_seule' });
    expect(compter()).toEqual(avant);
  }
  const r = await t.d.app.inject({
    method: 'POST',
    url: '/api/swarph/ecrire/apercu',
    headers: t.headers,
    payload: {
      action: 'dm.envoyer',
      params: { pair: 'peer-b', fil: null, kind: 'fyi', texte: 'Bonjour' },
    },
  });
  expect(r.statusCode).toBe(200);
  expect(r.json()).toMatchObject({ ok: true, aBlanc: true });
  expect(compter()).toEqual({ n: 0 });
});

test('D283 : sans proxy, lecture seule est sans effet sur le refus D262', async () => {
  const t = await preparer(false, true);
  for (const [route, action, params] of [
    ['ecrire', 'dm.envoyer', { pair: 'peer-b', fil: null, kind: 'fyi', texte: 'Bonjour' }],
    ['etat', 'obligation.prendre', { carte: 42, obligation: 81, attendu: { status: 'open' } }],
  ] as const) {
    const r = await t.d.app.inject({
      method: 'POST',
      url: `/api/swarph/${route}/envoyer`,
      headers: t.headers,
      payload: { action, params },
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('proxy_absent');
  }
});
