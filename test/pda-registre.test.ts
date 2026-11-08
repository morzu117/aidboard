import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { empreintePda } from '../src/shared/pda.js';
import { openDb } from '../src/daemon/db.js';
import { RegistrePda, RefusPda, type EnregistrementPda } from '../src/daemon/pda/registre.js';
import { RegistreAppareils } from '../src/daemon/host/appareils.js';
import { COOKIE_APPAREIL } from '../src/daemon/host/serveur.js';
import { startTestDaemon } from './helpers/daemon.js';
import { parseConfig } from '../src/daemon/config.js';
import { issueRunToken, SESSION_COOKIE } from '../src/daemon/security.js';

const nettoyages: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const f of nettoyages.reverse()) await f();
  nettoyages.length = 0;
});
function entree(): EnregistrementPda {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const { kty, crv, x, y } = publicKey.export({ format: 'jwk' });
  return {
    nom: 'Téléphone',
    credId: randomBytes(32).toString('base64url'),
    passkey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
    algorithme: -7,
    relais: { kty: kty!, crv: crv!, x: x!, y: y! },
  };
}
function preparer() {
  const dossier = mkdtempSync(join(tmpdir(), 'aid-pda-'));
  const db = openDb(join(dossier, 'state.db'));
  nettoyages.push(() => {
    db.close();
    rmSync(dossier, { recursive: true, force: true });
  });
  const journal = vi.fn();
  return { db, journal, registre: new RegistrePda(db, journal) };
}
test('empreinte stable, base32 et sensible à chacune des trois entrées', async () => {
  const e = entree();
  const a = await empreintePda(e);
  expect(a).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}$/);
  expect(
    await empreintePda({ ...e, relais: { y: e.relais.y, x: e.relais.x, kty: 'EC', crv: 'P-256' } }),
  ).toBe(a);
  for (const variante of [
    { ...e, credId: 'autre' },
    { ...e, passkey: 'autre' },
    { ...e, relais: entree().relais },
  ])
    expect(await empreintePda(variante)).not.toBe(a);
});
test('cycle, journal minimal, doublon et indépendance de l’accès de huit heures', async () => {
  const t = preparer();
  const acces = new RegistreAppareils(t.db);
  const a = acces.emettre({ nom: 'Test', identite: null });
  const e = entree();
  const { id, empreinte } = await t.registre.enregistrer(a.appareil.id, e);
  expect((await t.registre.lister())[0]).toMatchObject({ id, empreinte, etat: 'attente' });
  expect(t.registre.actif(id)?.actif).toBe(false);
  await expect(t.registre.enregistrer(a.appareil.id, e)).rejects.toMatchObject({ raison: 'connu' });
  expect(t.registre.activer(id)).toBe(true);
  expect(t.registre.activer(id)).toBe(false);
  acces.revoquer(a.appareil.id);
  acces.toutRevoquer();
  t.db.prepare('DELETE FROM appareils').run();
  expect(t.registre.actif(id)).toEqual({
    id,
    credId: e.credId,
    clePublique: e.passkey,
    actif: true,
  });
  expect(t.registre.revoquer(id)).toBe(true);
  expect(t.registre.activer(id)).toBe(false);
  expect(t.registre.revoquer(id)).toBe(false);
  expect(t.journal.mock.calls).toEqual([
    ['pda.active', { id }],
    ['pda.revoque', { id }],
  ]);
  const b = await t.registre.enregistrer('information', entree());
  expect(t.registre.revoquer(b.id)).toBe(true);
});
test('refus des clés, algorithmes et coordonnées invalides', async () => {
  const t = preparer();
  const e = entree();
  const p384 = generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).publicKey;
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey;
  for (const variante of [
    ...[p384, rsa].map((cle) => ({
      ...e,
      passkey: cle.export({ format: 'der', type: 'spki' }).toString('base64url'),
    })),
    { ...e, passkey: e.passkey.slice(0, 30) },
    { ...e, algorithme: -257 },
    { ...e, relais: { ...e.relais, d: 'secret' } },
    { ...e, relais: { ...e.relais, x: Buffer.alloc(31).toString('base64url') } },
  ])
    await expect(t.registre.enregistrer('information', variante)).rejects.toMatchObject({
      raison: 'cle',
    });
  expect(await t.registre.lister()).toEqual([]);
});

test('routes PDA : interrupteur, gardes, corps strict, admin et séparation des ports', async () => {
  const transport = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(null, { status: 204 }));
  nettoyages.push(() => transport.mockRestore());
  const t = await startTestDaemon(undefined, {
    tailscaleExec: async (_bin, args) => ({
      code: null,
      stdout:
        args[0] === 'status'
          ? JSON.stringify({
              BackendState: 'Running',
              Self: { DNSName: 'aid-e2e.ts.net.', UserID: 1 },
              User: {},
            })
          : '',
    }),
  });
  nettoyages.push(() => t.d.stop());
  const mac = (
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    payload?: unknown,
    headers = t.headers,
  ) => t.d.app.inject({ method, url, payload: payload as never, headers });
  expect(parseConfig('').modeHost.pda).toBe(false);
  await mac('PUT', '/api/host', { actif: true });
  const acces = new RegistreAppareils(t.db);
  const a = acces.emettre({ nom: 'Test', identite: null });
  const app = t.d.modeHost.instance()!;
  const headers = {
    host: 'aid-e2e.ts.net',
    origin: 'https://aid-e2e.ts.net',
    'sec-fetch-site': 'same-origin',
    cookie: `${COOKIE_APPAREIL}=${a.jeton}`,
  };
  const envoyer = (payload: unknown, h = headers) =>
    app.inject({
      method: 'POST',
      url: '/api/appareils/moi/pda',
      headers: h,
      payload: payload as never,
    });
  const e = entree();
  expect((await envoyer(e)).json()).toEqual({ raison: 'pda_coupe' });
  expect(
    (await mac('PUT', '/api/host/pda', { actif: true, relais: 'https://example.com' })).statusCode,
  ).toBe(200);
  expect((await envoyer(e, { ...headers, cookie: '' })).statusCode).toBe(401);
  expect((await envoyer(e, { ...headers, 'sec-fetch-site': 'cross-site' })).statusCode).toBe(403);
  expect((await envoyer({ ...e, extra: true })).statusCode).toBe(400);
  expect((await envoyer({ ...e, passkey: 'invalide' })).json()).toEqual({ raison: 'cle' });
  const r = await envoyer(e);
  expect(r.statusCode).toBe(200);
  expect(Object.keys(r.json()).sort()).toEqual(['empreinte', 'id']);
  expect((await envoyer(e)).statusCode).toBe(409);
  const id = r.json().id;
  const run = issueRunToken(t.d.auth, 'test');
  const nonAdmin = { host: t.headers.host!, authorization: `Bearer ${run}` };
  for (const [method, url] of [
    ['PUT', '/api/host/pda'],
    ['GET', '/api/host/pda/appareils'],
    ['POST', `/api/host/pda/appareils/${id}/activer`],
    ['POST', `/api/host/pda/appareils/${id}/revoquer`],
  ] as const) {
    expect((await mac(method, url, undefined, nonAdmin)).statusCode).toBe(403);
    expect((await app.inject({ method, url, headers })).statusCode).toBe(404);
  }
  expect(
    (
      await mac(
        'POST',
        `/api/host/pda/appareils/${id}/activer`,
        { empreinte: r.json().empreinte },
        {
          host: t.headers.host!,
          origin: `http://${t.headers.host}`,
          'sec-fetch-site': 'same-origin',
          cookie: `${SESSION_COOKIE}=${t.d.auth.sessionToken}`,
        },
      )
    ).statusCode,
  ).toBe(200);
  await mac('PUT', '/api/host/pda', { actif: false });
  const liste = (await mac('GET', '/api/host/pda/appareils')).json();
  expect(liste[0]).toMatchObject({ id, etat: 'actif', empreinte: r.json().empreinte });
  expect(Object.keys(liste[0]).sort()).toEqual(
    ['id', 'nom', 'etat', 'empreinte', 'cree_a', 'active_a', 'revoque_a'].sort(),
  );
  acces.revoquer(a.appareil.id);
  expect((await envoyer(entree())).statusCode).toBe(401);
  expect(new RegistrePda(t.db, vi.fn()).actif(id)?.actif).toBe(true);
  expect((await mac('POST', `/api/host/pda/appareils/${id}/revoquer`)).statusCode).toBe(200);
});

test('deux enregistrements concurrents du même cred_id : un succès et un refus connu', async () => {
  const { registre } = preparer();
  const e = entree();
  const resultats = await Promise.allSettled([
    registre.enregistrer('information', e),
    registre.enregistrer('information', e),
  ]);
  expect(resultats.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  const refus = resultats.find((r) => r.status === 'rejected');
  expect(refus?.reason).toBeInstanceOf(RefusPda);
  expect(refus?.reason).toMatchObject({ raison: 'connu' });
  expect(await registre.lister()).toHaveLength(1);
});
