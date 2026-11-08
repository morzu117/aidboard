import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { createServer, request, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { creerRelais, type OptionsRelais } from '../src/relais/index.js';
import {
  estBasse,
  hacher,
  octetsRequeteRelais,
  ORDRE_P256,
  signatureBasse,
} from '../src/shared/pda.js';

let sequence = 0;

function remplacerS(signature: Buffer, s: bigint): Buffer {
  return Buffer.concat([
    signature.subarray(0, 32),
    Buffer.from(s.toString(16).padStart(64, '0'), 'hex'),
  ]);
}

const daemon = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const telephone = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = daemon.publicKey.export({ format: 'jwk' });
const cleDaemon = Buffer.concat([
  Buffer.from([4]),
  Buffer.from(jwk.x!, 'base64url'),
  Buffer.from(jwk.y!, 'base64url'),
]).toString('base64url');
const cleApp = telephone.publicKey.export({ format: 'jwk' });
const origineApp = 'https://example.com';
const id = (n = 0) => Buffer.alloc(16, n).toString('base64url');
let serveur: Server;
let port: number;
let heure: number;
let lignes: unknown[];

async function lancer(options: Partial<OptionsRelais> = {}) {
  serveur = createServer(
    creerRelais({
      origineApp,
      cleDaemon,
      now: () => heure,
      journal: (e) => lignes.push(e),
      ...options,
    }),
  );
  await new Promise<void>((resolve) => serveur.listen(0, '127.0.0.1', resolve));
  port = (serveur.address() as { port: number }).port;
}
function envoyer(
  methode: string,
  chemin: string,
  corps = '',
  headers: Record<string, string> = {},
) {
  return new Promise<{
    statut: number;
    headers: Record<string, string | string[] | undefined>;
    corps: string;
  }>((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, method: methode, path: chemin, headers },
      (res) => {
        const morceaux: Buffer[] = [];
        res.on('data', (c) => morceaux.push(c));
        res.on('end', () =>
          resolve({
            statut: res.statusCode!,
            headers: res.headers,
            corps: Buffer.concat(morceaux).toString(),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(corps);
  });
}
async function entetes(
  methode: string,
  chemin: string,
  corps: string,
  cle: KeyObject,
  date = heure + sequence++,
  contexte = true,
) {
  let octets = octetsRequeteRelais({
    methode,
    chemin,
    hachageCorps: await hacher(Buffer.from(corps)),
    heure: String(date),
  });
  if (!contexte) octets = octets.slice('aid-pda-relais-v1\n'.length);
  const signature = sign('sha256', octets, { key: cle, dsaEncoding: 'ieee-p1363' });
  return {
    'X-Aid-Heure': String(date),
    'X-Aid-Sig': Buffer.from(signatureBasse(signature)).toString('base64url'),
  };
}
async function signee(
  methode: string,
  chemin: string,
  corps = '',
  app = false,
  headers: Record<string, string> = {},
) {
  return envoyer(methode, chemin, corps, {
    ...(await entetes(methode, chemin, corps, app ? telephone.privateKey : daemon.privateKey)),
    ...(app ? { 'X-Aid-Appareil': 'telephone' } : {}),
    ...headers,
  });
}
async function autoriser() {
  const { kty, crv, x, y } = cleApp;
  expect(
    (
      await signee(
        'PUT',
        '/autorises',
        JSON.stringify({ appareils: [{ id: 'telephone', cle: { kty, crv, x, y } }] }),
      )
    ).statut,
  ).toBe(204);
}
function enveloppe(echeance = heure + 300000) {
  return JSON.stringify({
    corps: Buffer.from(JSON.stringify({ echeance, sujet: 'SUJET_CONFIDENTIEL' })).toString(
      'base64url',
    ),
    sig: 'signature-opaque',
  });
}
async function deposer(n = 0, echeance?: number) {
  return signee('PUT', `/demandes/${id(n)}`, enveloppe(echeance));
}

beforeEach(async () => {
  heure = 1800000000000;
  lignes = [];
  await lancer();
});
afterEach(async () => {
  serveur.closeAllConnections();
  await new Promise<void>((resolve) => serveur.close(() => resolve()));
});

describe('relais PDA', () => {
  it('fait le cycle complet et ne journalise que les métadonnées autorisées', async () => {
    await autoriser();
    expect((await deposer()).statut).toBe(204);
    const liste = await signee('GET', '/demandes', '', true);
    expect(JSON.parse(liste.corps)).toEqual([{ id: id(), ...JSON.parse(enveloppe()) }]);
    expect((await signee('POST', `/reponses/${id()}`, '{"opaque":true}', true)).statut).toBe(204);
    const tirees = JSON.parse((await signee('GET', '/reponses?apres=0')).corps);
    expect(tirees).toEqual([
      {
        curseur: 1,
        id: id(),
        appareil: 'telephone',
        corps: Buffer.from('{"opaque":true}').toString('base64url'),
      },
    ]);
    expect(JSON.parse((await signee('GET', '/reponses?apres=0')).corps)).toEqual([]);
    expect((await signee('DELETE', `/demandes/${id()}`)).statut).toBe(204);
    expect(JSON.parse((await signee('GET', '/demandes', '', true)).corps)).toEqual([]);
    const journal = JSON.stringify(lignes);
    expect(journal).not.toContain('SUJET_CONFIDENTIEL');
    expect(journal).not.toContain('signature-opaque');
    expect(journal).not.toContain('X-Aid-Sig');
    for (const ligne of lignes)
      expect(
        Object.keys(ligne as object).every((k) =>
          ['methode', 'route', 'statut', 'id', 'appareil'].includes(k),
        ),
      ).toBe(true);
  });

  it('refuse les signatures absentes, croisées, inconnues, hors contexte et les heures hors fenêtre', async () => {
    await autoriser();
    const cas = [
      envoyer('GET', '/demandes'),
      signee('GET', '/demandes', '', false, { 'X-Aid-Appareil': 'telephone' }),
      signee('GET', '/reponses?apres=0', '', true),
      signee('GET', '/demandes', '', true, { 'X-Aid-Appareil': 'inconnu' }),
      envoyer('GET', '/demandes', '', {
        ...(await entetes('GET', '/demandes', '', telephone.privateKey, heure - 61000)),
        'X-Aid-Appareil': 'telephone',
      }),
      envoyer(
        'GET',
        '/reponses?apres=0',
        '',
        await entetes('GET', '/reponses?apres=0', '', daemon.privateKey, heure, false),
      ),
      envoyer(
        'GET',
        '/reponses?apres=1',
        '',
        await entetes('GET', '/reponses?apres=0', '', daemon.privateKey),
      ),
    ];
    for (const reponse of await Promise.all(cas)) {
      expect(reponse.statut).toBe(401);
      expect(reponse.corps).toBe('');
    }
    const headers = await entetes('GET', '/reponses?apres=0', '', daemon.privateKey);
    expect((await envoyer('GET', '/reponses?apres=0', '', headers)).statut).toBe(200);
    expect((await envoyer('GET', '/reponses?apres=0', '', headers)).statut).toBe(401);
  });

  it('refuse le rejeu avec s remplacé par n − s et une nouvelle signature des mêmes octets', async () => {
    const headers = await entetes('GET', '/reponses?apres=0', '', daemon.privateKey, heure);
    const signature = Buffer.from(headers['X-Aid-Sig'], 'base64url');
    const s = BigInt(`0x${signature.subarray(32).toString('hex')}`);
    expect(estBasse(signature)).toBe(true);
    expect((await envoyer('GET', '/reponses?apres=0', '', headers)).statut).toBe(200);
    const haute = remplacerS(signature, ORDRE_P256 - s).toString('base64url');
    expect(
      (await envoyer('GET', '/reponses?apres=0', '', { ...headers, 'X-Aid-Sig': haute })).statut,
    ).toBe(401);
    const nouvelle = await entetes('GET', '/reponses?apres=0', '', daemon.privateKey, heure);
    expect((await envoyer('GET', '/reponses?apres=0', '', nouvelle)).statut).toBe(401);
  });

  it('refuse une signature à s haut même sans requête précédente', async () => {
    const headers = await entetes('GET', '/reponses?apres=0', '', daemon.privateKey);
    const signature = Buffer.from(headers['X-Aid-Sig'], 'base64url');
    const s = ORDRE_P256 - BigInt(`0x${signature.subarray(32).toString('hex')}`);
    expect(estBasse(remplacerS(signature, s))).toBe(false);
    const reponse = await envoyer('GET', '/reponses?apres=0', '', {
      ...headers,
      'X-Aid-Sig': remplacerS(signature, s).toString('base64url'),
    });
    expect(reponse.statut).toBe(401);
    expect(reponse.corps).toBe('');
    expect((await envoyer('GET', '/reponses?apres=0', '', headers)).statut).toBe(200);
  });

  it('borne les corps avant de vérifier la signature', async () => {
    expect((await envoyer('PUT', `/demandes/${id()}`, 'x'.repeat(16385))).statut).toBe(413);
    await autoriser();
    await deposer();
    expect((await signee('POST', `/reponses/${id()}`, 'x'.repeat(8193), true)).statut).toBe(413);
  });

  it('borne les demandes et refuse les échéances absentes, illisibles ou passées', async () => {
    for (let i = 0; i < 32; i++) expect((await deposer(i)).statut).toBe(204);
    expect((await deposer(32)).statut).toBe(429);
    expect((await deposer(33, heure - 1)).statut).toBe(400);
    for (const corps of ['{}', 'illisible']) {
      expect(
        (
          await signee(
            'PUT',
            `/demandes/${id(34)}`,
            JSON.stringify({ corps: Buffer.from(corps).toString('base64url'), sig: '' }),
          )
        ).statut,
      ).toBe(400);
    }
  });

  it('borne les réponses par demande, refuse les inconnues et les échues', async () => {
    await autoriser();
    await deposer();
    for (let i = 0; i < 4; i++)
      expect((await signee('POST', `/reponses/${id()}`, 'opaque', true)).statut).toBe(204);
    expect((await signee('POST', `/reponses/${id()}`, 'opaque', true)).statut).toBe(429);
    expect((await signee('POST', `/reponses/${id(1)}`, '', true)).statut).toBe(404);
    heure += 300000;
    expect((await signee('POST', `/reponses/${id()}`, '', true)).statut).toBe(404);
  });

  it('applique CORS à la seule origine exacte et répond au préflight', async () => {
    for (const origin of [origineApp, 'https://autre.example.com']) {
      const r = await envoyer('OPTIONS', '/demandes', '', { Origin: origin });
      expect(r.statut).toBe(204);
      expect(r.headers['access-control-allow-origin']).toBe(
        origin === origineApp ? origineApp : undefined,
      );
      expect(r.headers['access-control-allow-credentials']).toBeUndefined();
      if (origin === origineApp) {
        expect(r.headers['access-control-allow-methods']).toBe('GET, POST');
        expect(r.headers['access-control-allow-headers']).toBe(
          'X-Aid-Heure, X-Aid-Sig, X-Aid-Appareil, Content-Type',
        );
        expect(r.headers['access-control-max-age']).toBe('600');
      }
    }
    await autoriser();
    expect(
      (await signee('GET', '/demandes', '', true, { Origin: origineApp })).headers[
        'access-control-allow-origin'
      ],
    ).toBe(origineApp);
  });

  it('limite la 61e requête app et les échecs daemon, puis purge le compteur', async () => {
    await autoriser();
    for (let i = 0; i < 60; i++)
      expect((await signee('GET', '/demandes', '', true)).statut).toBe(200);
    expect((await signee('GET', '/demandes', '', true)).statut).toBe(429);
    expect((await envoyer('GET', '/reponses?apres=0')).statut).toBe(429);
    heure += 60000;
    expect((await envoyer('GET', '/reponses?apres=0')).statut).toBe(401);
  });

  it('ne fait confiance au dernier saut que sur option explicite', async () => {
    await autoriser();
    for (let i = 0; i < 60; i++)
      await envoyer('GET', '/demandes', '', { 'X-Forwarded-For': `192.0.2.${i}` });
    expect(
      (await envoyer('GET', '/demandes', '', { 'X-Forwarded-For': '203.0.113.1' })).statut,
    ).toBe(429);
    serveur.closeAllConnections();
    await new Promise<void>((resolve) => serveur.close(() => resolve()));
    await lancer({ confianceProxy: true });
    for (let i = 0; i < 60; i++)
      expect(
        (await envoyer('GET', '/demandes', '', { 'X-Forwarded-For': `192.0.2.${i}, 203.0.113.1` }))
          .statut,
      ).toBe(401);
    expect(
      (await envoyer('GET', '/demandes', '', { 'X-Forwarded-For': '192.0.2.200, 203.0.113.1' }))
        .statut,
    ).toBe(429);
    expect(
      (await envoyer('GET', '/demandes', '', { 'X-Forwarded-For': '203.0.113.1, 192.0.2.200' }))
        .statut,
    ).toBe(401);
  });

  it('ne sert aucun contenu, sans normaliser les chemins', async () => {
    for (const [methode, chemin] of [
      ['GET', '/'],
      ['GET', '/index.html'],
      ['GET', '/sw.js'],
      ['GET', '/demandes/../x'],
      ['PUT', '/x'],
    ] as const) {
      const r = await envoyer(methode, chemin);
      expect(r.statut).toBe(404);
      expect(r.corps).toBe('');
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['content-security-policy']).toBe(
        "default-src 'none'; frame-ancestors 'none'",
      );
    }
  });

  it('purge les demandes à échéance et les réponses après dix minutes', async () => {
    await autoriser();
    await deposer();
    await signee('POST', `/reponses/${id()}`, 'opaque', true);
    heure += 300000;
    expect(JSON.parse((await signee('GET', '/demandes', '', true)).corps)).toEqual([]);
    heure += 300000;
    expect(JSON.parse((await signee('GET', '/reponses?apres=0')).corps)).toEqual([]);
  });

  it('borne le total à 128 réponses et conserve le plafond par demande après tirage', async () => {
    await autoriser();
    for (let n = 0; n < 32; n++) {
      await deposer(n);
      for (let i = 0; i < 4; i++) {
        expect((await signee('POST', `/reponses/${id(n)}`, 'opaque', true)).statut).toBe(204);
      }
      if (n % 10 === 9) heure += 60000;
    }
    await signee('DELETE', `/demandes/${id(31)}`);
    await deposer(32);
    expect((await signee('POST', `/reponses/${id(32)}`, '', true)).statut).toBe(429);
    expect(JSON.parse((await signee('GET', '/reponses?apres=127')).corps)).toHaveLength(1);
    expect((await signee('POST', `/reponses/${id(32)}`, '', true)).statut).toBe(204);
    expect((await signee('POST', `/reponses/${id()}`, '', true)).statut).toBe(429);
  });

  it('purge les signatures après leur fenêtre et borne la liste à 64 appareils', async () => {
    const headers = await entetes('GET', '/reponses?apres=0', '', daemon.privateKey);
    expect((await envoyer('GET', '/reponses?apres=0', '', headers)).statut).toBe(200);
    heure += 60001;
    expect((await envoyer('GET', '/reponses?apres=0', '', headers)).statut).toBe(401);
    expect((await signee('GET', '/reponses?apres=0')).statut).toBe(200);
    const { kty, crv, x, y } = cleApp;
    const appareils = Array.from({ length: 65 }, (_, i) => ({
      id: `appareil-${i}`,
      cle: { kty, crv, x, y },
    }));
    expect((await signee('PUT', '/autorises', JSON.stringify({ appareils }))).statut).toBe(400);
    appareils.pop();
    expect((await signee('PUT', '/autorises', JSON.stringify({ appareils }))).statut).toBe(204);
  });

  it('remplace atomiquement la liste autorisée et refuse une clé malformée', async () => {
    await autoriser();
    expect((await signee('PUT', '/autorises', '{"appareils":[{}]}')).statut).toBe(400);
    expect((await signee('GET', '/demandes', '', true)).statut).toBe(200);
    expect((await signee('PUT', '/autorises', '{"appareils":[]}')).statut).toBe(204);
    expect((await signee('GET', '/demandes', '', true)).statut).toBe(401);
  });
});
