import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClientCommandant, erreurCommandant } from '../src/daemon/commandant/client.js';
import { digestCommandant } from '../src/shared/commandant.js';
import {
  creerPasserelleCommandant,
  IDENTIFIANT_COCKPIT_TEST,
  ligneCommandantTest,
} from './fixtures/passerelle-commandant.js';

let faux: Awaited<ReturnType<typeof creerPasserelleCommandant>>;
afterEach(async () => {
  await faux?.fermer();
  faux = undefined!;
});
async function preparer() {
  faux = await creerPasserelleCommandant();
  return new ClientCommandant(faux.url, IDENTIFIANT_COCKPIT_TEST);
}
async function brut(id: number, corps: unknown) {
  const r = await fetch(`${faux.url}/commander/requests/${id}/decide`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${IDENTIFIANT_COCKPIT_TEST}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(corps),
  });
  return { http: r.status, corps: await r.json() };
}
describe('client HTTP et faux contractuel', () => {
  it('liste pending, lit le détail et envoie le corps answer exact', async () => {
    const c = await preparer();
    expect((await c.liste()).ok).toBe(true);
    expect((await c.detail(1235)).ok).toBe(true);
    const digest = digestCommandant(faux.lignes.get(1235)!);
    expect(await c.decider(1235, 'oui', digest)).toMatchObject({
      ok: true,
      valeur: { decided_via: 'cockpit', decided_by: 'cockpit:ck_1234abcd', answer: 'oui' },
    });
    expect(faux.appels.map((a) => `${a.methode} ${a.chemin}`)).toEqual([
      'GET /commander/requests?status=pending',
      'GET /commander/requests/1235',
      'POST /commander/requests/1235/decide',
    ]);
    expect(faux.appels.every((a) => a.authorization === `Bearer ${IDENTIFIANT_COCKPIT_TEST}`)).toBe(
      true,
    );
    expect(faux.appels[2]!.corps).toEqual({ decision: 'answer', answer: 'oui', digest });
  });
  it.each([
    ['expire', 'cockpit_credential_expired'],
    ['revoque', 'cockpit_credential_revoked'],
    ['inconnu', 'cockpit_credential_unknown'],
  ] as const)('type le 401 %s', async (etat, code) => {
    const c = await preparer();
    faux.scenario.identifiant = etat;
    expect(await c.liste()).toEqual({
      ok: false,
      erreur: { genre: 'passerelle', http: 401, code },
    });
  });
  it.each([
    [400, 'bad_decision'],
    [400, 'bad_answer'],
    [400, 'digest_required'],
    [403, 'needs_sso'],
    [403, 'cockpit_not_allowed'],
    [404, 'not_found'],
    [409, 'digest_mismatch'],
  ] as const)('type le corps %i %s', async (http, error) => {
    const c = await preparer();
    faux.scenario.erreurListe = { http, corps: { error } };
    expect(await c.liste()).toEqual({
      ok: false,
      erreur: { genre: 'passerelle', http, code: error },
    });
  });
  it('type not_pending avec son statut et le 422 sans input ni message distant', async () => {
    const c = await preparer();
    faux.lignes.get(1235)!.status = 'answered';
    expect(await c.decider(1235, 'oui', '0'.repeat(64))).toMatchObject({
      erreur: { code: 'not_pending', statut: 'answered' },
    });
    const r = await brut(1235, { answer: 'oui' });
    expect(r.http).toBe(422);
    expect(erreurCommandant(r.http, r.corps, IDENTIFIANT_COCKPIT_TEST)).toEqual({
      genre: 'validation',
      http: 422,
      code: 'champ_requis',
      champs: [['body', 'decision']],
    });
    const sale = erreurCommandant(
      422,
      {
        detail: [
          {
            loc: ['body', IDENTIFIANT_COCKPIT_TEST],
            input: IDENTIFIANT_COCKPIT_TEST,
            msg: IDENTIFIANT_COCKPIT_TEST,
          },
        ],
      },
      IDENTIFIANT_COCKPIT_TEST,
    );
    expect(JSON.stringify(sale).includes(IDENTIFIANT_COCKPIT_TEST)).toBe(false);
  });
  it('applique toutes les priorités A.1 et rend les corps exacts', async () => {
    await preparer();
    const bon = { decision: 'answer', answer: 'oui', digest: '0'.repeat(64) };
    faux.scenario.identifiant = 'expire';
    expect(await brut(9999, {})).toEqual({
      http: 401,
      corps: { error: 'cockpit_credential_expired' },
    });
    faux.scenario.identifiant = 'valide';
    expect(await brut(9999, {})).toEqual({ http: 404, corps: { error: 'not_found' } });
    expect(await brut(1234, {})).toEqual({ http: 403, corps: { error: 'cockpit_not_allowed' } });
    const ligne = faux.lignes.get(1235)!;
    ligne.needs_sso = true;
    ligne.params.needs_sso = true;
    expect(await brut(1235, {})).toEqual({ http: 403, corps: { error: 'needs_sso' } });
    ligne.needs_sso = false;
    ligne.params.needs_sso = false;
    ligne.status = 'answered';
    expect(await brut(1235, { ...bon, decision: 'approve', answer: '' })).toEqual({
      http: 400,
      corps: { error: 'bad_decision' },
    });
    for (const answer of ['', 'x'.repeat(1001), '\u0001'])
      expect(await brut(1235, { ...bon, answer })).toEqual({
        http: 400,
        corps: { error: 'bad_answer' },
      });
    for (const digest of [null, 'A'.repeat(64), undefined])
      expect(await brut(1235, { ...bon, digest })).toEqual({
        http: 400,
        corps: { error: 'digest_required' },
      });
    expect(await brut(1235, bon)).toEqual({
      http: 409,
      corps: { error: 'not_pending', status: 'answered' },
    });
    ligne.status = 'pending';
    expect(await brut(1235, bon)).toEqual({ http: 409, corps: { error: 'digest_mismatch' } });
    expect((await brut(1235, { decision: 'answer' })).http).toBe(422);
  });
  it('le middleware refuse le credential hors des trois appels permis', async () => {
    await preparer();
    for (const chemin of [
      '/commander/requests',
      '/commander/cockpit-credential',
      '/authorizations',
      '/inconnu',
    ]) {
      const r = await fetch(faux.url + chemin, {
        method: 'POST',
        headers: { Authorization: `Bearer ${IDENTIFIANT_COCKPIT_TEST}` },
      });
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual({ error: 'cockpit_not_allowed' });
    }
  });
  it('rend une ancienne ligne en lecture seule et refuse sa réponse', async () => {
    await preparer();
    faux.lignes.set(
      2,
      ligneCommandantTest(2, 'decision', {
        question: 'q'.repeat(361),
        options: [],
        needs_sso: false,
      }),
    );
    const c = new ClientCommandant(faux.url, IDENTIFIANT_COCKPIT_TEST);
    expect(await c.detail(2)).toMatchObject({
      ok: true,
      valeur: {
        summary: ['This question exceeds the cockpit limits: answer it in the Command Center.'],
      },
    });
    expect(await c.decider(2, 'oui', digestCommandant(faux.lignes.get(2)!))).toMatchObject({
      erreur: { code: 'needs_sso' },
    });
  });
  it('coupe la question tous les 120 caractères et met une option par ligne', async () => {
    const c = await preparer();
    faux.lignes.set(
      2,
      ligneCommandantTest(2, 'decision', {
        question: 'q'.repeat(360),
        options: ['a', 'b'],
        needs_sso: false,
      }),
    );
    const r = await c.detail(2);
    expect(r).toMatchObject({
      valeur: {
        summary: [
          'Question from cell-lab:',
          'q'.repeat(120),
          'q'.repeat(120),
          'q'.repeat(120),
          'Option: a',
          'Option: b',
        ],
      },
    });
  });
  it('refuse protocole, identifiants URL, id invalide et credential mal formé sans transport', async () => {
    for (const gateway of [
      'file:///exemple',
      'ftp://example.com',
      'http://user:pass@example.com',
      'pas une url',
    ])
      expect(await new ClientCommandant(gateway, IDENTIFIANT_COCKPIT_TEST).liste()).toMatchObject({
        erreur: { code: 'gateway' },
      });
    expect(await new ClientCommandant('https://example.com', 'invalide').liste()).toMatchObject({
      erreur: { code: 'identifiant' },
    });
    expect(
      await new ClientCommandant('https://example.com', IDENTIFIANT_COCKPIT_TEST).detail(NaN),
    ).toMatchObject({ erreur: { code: 'requete' } });
  });
  it('borne le délai, la taille annoncée et la taille du flux sans content-length', async () => {
    await preparer();
    faux.scenario.delaiMs = 100;
    expect(
      await new ClientCommandant(faux.url, IDENTIFIANT_COCKPIT_TEST, { delaiMs: 10 }).liste(),
    ).toMatchObject({ erreur: { code: 'delai' } });
    faux.scenario.delaiMs = 0;
    expect(
      await new ClientCommandant(faux.url, IDENTIFIANT_COCKPIT_TEST, { maximumOctets: 10 }).liste(),
    ).toMatchObject({ erreur: { code: 'taille' } });
    const transport: typeof fetch = async () =>
      new Response('x'.repeat(30), { headers: { 'Content-Length': '30' } });
    expect(
      await new ClientCommandant(faux.url, IDENTIFIANT_COCKPIT_TEST, {
        maximumOctets: 10,
        transport,
      }).liste(),
    ).toMatchObject({ erreur: { code: 'taille' } });
  });
  it('borne aussi une réponse qui commence puis bloque et ne suit pas une redirection', async () => {
    await preparer();
    const transport: typeof fetch = async (_url, options) =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('['));
            options?.signal?.addEventListener('abort', () => c.error(new Error('transport')));
          },
        }),
      );
    expect(
      await new ClientCommandant(faux.url, IDENTIFIANT_COCKPIT_TEST, {
        delaiMs: 10,
        transport,
      }).liste(),
    ).toMatchObject({ erreur: { code: 'delai' } });
    faux.scenario.erreurListe = { http: 302, corps: {} };
    expect(await new ClientCommandant(faux.url, IDENTIFIANT_COCKPIT_TEST).liste()).toMatchObject({
      erreur: { code: 'http', http: 302 },
    });
    expect(faux.appels).toHaveLength(1);
  });
  it('ne propage jamais le secret réfléchi ni une erreur de transport', async () => {
    const c = await preparer();
    faux.scenario.corpsListe = { texte: IDENTIFIANT_COCKPIT_TEST };
    expect(await c.liste()).toMatchObject({ erreur: { code: 'json' } });
    const transport: typeof fetch = async () => {
      throw new Error(IDENTIFIANT_COCKPIT_TEST);
    };
    expect(
      await new ClientCommandant(faux.url, IDENTIFIANT_COCKPIT_TEST, { transport }).liste(),
    ).toEqual({ ok: false, erreur: { genre: 'transport', code: 'reseau' } });
    faux.scenario.corpsListe = undefined;
    faux.scenario.texteBrut = 'invalide';
    expect(await c.liste()).toMatchObject({ erreur: { code: 'json' } });
  });
});
it.each([
  'http://example.com',
  'http://100.63.255.255',
  'http://100.128.0.0',
  'http://[fd7a:115c:a1df:ffff:ffff:ffff:ffff:ffff]',
  'http://[fd7a:115c:a1e1::]',
  'http://aid-e2e.ts.net.example.com',
])('refuse la passerelle HTTP hors du réseau autorisé %s sans transport', async (gateway) => {
  const transport = vi.fn<typeof fetch>(async () => new Response('[]'));
  const client = new ClientCommandant(gateway, IDENTIFIANT_COCKPIT_TEST, { transport });
  for (const resultat of [
    await client.liste(),
    await client.detail(1235),
    await client.decider(1235, 'oui', '0'.repeat(64)),
  ]) {
    expect(resultat).toEqual({ ok: false, erreur: { genre: 'transport', code: 'gateway' } });
  }
  expect(transport).not.toHaveBeenCalled();
});
it.each([
  'http://localhost',
  'http://127.0.0.1',
  'http://127.255.255.255',
  'http://[::1]',
  'http://100.64.0.1',
  'http://100.127.255.255',
  'http://[fd7a:115c:a1e0::1]',
  'http://[FD7A:115C:A1E0:FFFF:FFFF:FFFF:FFFF:FFFF]',
  'http://aid-e2e.ts.net',
  'https://example.com',
])('accepte la passerelle %s', async (gateway) => {
  const transport = vi.fn<typeof fetch>(async () => new Response('[]'));
  expect(
    await new ClientCommandant(gateway, IDENTIFIANT_COCKPIT_TEST, { transport }).liste(),
  ).toEqual({ ok: true, valeur: [] });
  expect(transport).toHaveBeenCalledTimes(1);
});
