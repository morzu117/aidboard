// @vitest-environment jsdom
import { webcrypto, generateKeyPairSync, sign, createHash } from 'node:crypto';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { AppPda } from '../../web/src/AppPda.js';
import * as pda from '../../web/src/data/pda.js';
import {
  CONTEXTE_DEMANDE,
  decoderBase64url,
  defiReponse,
  encoderBase64url,
  estBasse,
  empreintePda,
  hacher,
  octetsRequeteRelais,
} from '../../src/shared/pda.js';
import { verifierAssertion } from '../../src/daemon/pda/webauthn.js';
import { indexedDBMemoire } from './indexedDBMemoire.js';

const encode = (v: Uint8Array) => encoderBase64url(v);
const daemon = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = daemon.publicKey.export({ format: 'jwk' });
const cle = encode(new Uint8Array([4, ...decoderBase64url(jwk.x!), ...decoderBase64url(jwk.y!)]));
const credId = encode(new Uint8Array([1, 2, 3]));
let local: pda.PdaLocal;
let publiqueRelais: CryptoKey;
let memoire: ReturnType<typeof indexedDBMemoire>;
let enveloppe: { corps: string; sig: string };
let demande: {
  v: 1;
  id: string;
  action: 'essai';
  sujet: string;
  numero: string;
  emise: number;
  echeance: number;
};
const reseau = vi.fn<typeof fetch>();
const get = vi.fn();
const create = vi.fn();
function signer() {
  const corps = Buffer.from(JSON.stringify(demande));
  enveloppe = {
    corps: encode(corps),
    sig: encode(
      sign('sha256', Buffer.concat([Buffer.from(CONTEXTE_DEMANDE), corps]), {
        key: daemon.privateKey,
        dsaEncoding: 'ieee-p1363',
      }),
    ),
  };
}
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto);
  memoire = indexedDBMemoire();
  vi.stubGlobal('indexedDB', memoire.fabrique);
  vi.stubGlobal('fetch', reseau);
  Object.defineProperty(navigator, 'credentials', { configurable: true, value: { get, create } });
  const paire = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
    'sign',
  ]);
  publiqueRelais = await crypto.subtle.importKey(
    'jwk',
    { ...(await crypto.subtle.exportKey('jwk', paire.publicKey)), key_ops: ['verify'] },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  local = { id: 'pda_test', credId, cleRelais: paire.privateKey };
  await pda.stockagePda(local);
  vi.spyOn(pda, 'chargerCodePda').mockResolvedValue({
    CLE_DAEMON: cle,
    RELAIS: 'https://example.com',
  });
  demande = {
    v: 1,
    id: encode(new Uint8Array(16)),
    action: 'essai',
    sujet: '<img src=x onerror=alert(1)>',
    numero: '1234',
    emise: Date.now(),
    echeance: Date.now() + 300000,
  };
  signer();
  reseau.mockImplementation(async () => new Response(JSON.stringify([enveloppe])));
  window.history.replaceState(null, '', '/pda');
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  reseau.mockReset();
  get.mockReset();
  create.mockReset();
  window.history.replaceState(null, '', '/');
});

test('signature fausse : aucun contenu affiché', async () => {
  enveloppe.sig = encode(new Uint8Array(64));
  render(<AppPda />);
  expect(await screen.findByText('1 demande illisible ignorée')).toBeTruthy();
  expect(screen.queryByText(demande.sujet)).toBeNull();
});
test('sujet en texte et numéro retapé exactement, démarrage sans API', async () => {
  render(<AppPda />);
  expect(await screen.findByText(demande.sujet)).toBeTruthy();
  expect(document.querySelector('img')).toBeNull();
  const bouton = screen.getByRole('button', { name: 'Confirmer' }) as HTMLButtonElement;
  expect(bouton.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Retape le numéro'), { target: { value: '123' } });
  expect(bouton.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Retape le numéro'), { target: { value: '1234' } });
  expect(bouton.disabled).toBe(false);
  expect(reseau.mock.calls.every(([url]) => !String(url).includes('/api/'))).toBe(true);
});
test('64 Kio + 1 refusés avant parsing, lecture en flux', async () => {
  const parse = vi.spyOn(JSON, 'parse');
  await expect(pda.lireDemandes(new Response(' '.repeat(65537)), cle)).rejects.toThrow(
    'Réponse trop grande',
  );
  expect(parse).not.toHaveBeenCalled();
});
test('demande échue ignorée', async () => {
  demande.echeance = Date.now() - 1;
  signer();
  expect((await pda.lireDemandes(new Response(JSON.stringify([enveloppe])), cle)).demandes).toEqual(
    [],
  );
});
test.each(['oui', 'non'] as const)(
  'défi exact et assertion %s acceptée par le daemon, signature DER Node',
  async (valeur) => {
    const passkey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    get.mockImplementation(async ({ publicKey }) => {
      const client = Buffer.from(
        JSON.stringify({
          type: 'webauthn.get',
          origin: location.origin,
          challenge: encode(publicKey.challenge),
        }),
      );
      const auth = Buffer.concat([
        createHash('sha256').update(location.hostname).digest(),
        Buffer.from([5, 0, 0, 0, 0]),
      ]);
      const signature = sign(
        'sha256',
        Buffer.concat([auth, createHash('sha256').update(client).digest()]),
        passkey.privateKey,
      );
      const buffer = (v: Uint8Array) => new Uint8Array(v).buffer;
      return {
        rawId: buffer(decoderBase64url(credId)),
        response: {
          authenticatorData: buffer(auth),
          clientDataJSON: buffer(client),
          signature: buffer(signature),
        },
      };
    });
    const hDemande = await hacher(decoderBase64url(enveloppe.corps));
    const corps = await pda.fabriquerReponse(
      { demande, corps: enveloppe.corps },
      local,
      valeur,
      demande.numero,
    );
    expect(Object.keys(corps).sort()).toEqual(
      [
        'appareil',
        'demande',
        'rawId',
        'authenticatorData',
        'clientDataJSON',
        'signature',
        'valeur',
        'numero',
      ].sort(),
    );
    expect(corps.numero).toBe(valeur === 'non' ? null : demande.numero);
    const options = get.mock.calls[0]![0].publicKey;
    expect(options.userVerification).toBe('required');
    expect(options.allowCredentials).toEqual([
      { type: 'public-key', id: decoderBase64url(credId) },
    ]);
    expect(options.challenge).toEqual(
      await defiReponse({
        id: demande.id,
        hDemande,
        appareil: local.id,
        echeance: demande.echeance,
        valeur,
        numero: valeur === 'non' ? '' : demande.numero,
      }),
    );
    expect(
      await verifierAssertion(corps, {
        appareil: {
          id: local.id,
          credId,
          clePublique: encode(passkey.publicKey.export({ format: 'der', type: 'spki' })),
          actif: true,
        },
        demande: { id: demande.id, numero: demande.numero, echeance: demande.echeance, hDemande },
        origine: location.origin,
        rpId: location.hostname,
        maintenant: Date.now(),
      }),
    ).toEqual({ ok: true, valeur });
    await pda.requeteRelais('https://example.com', local, `/reponses/${demande.id}`, corps);
    const [, requete] = reseau.mock.calls[0]!;
    expect(requete).toMatchObject({ credentials: 'omit', redirect: 'error', cache: 'no-store' });
    const headers = requete!.headers as Record<string, string>;
    const sig = decoderBase64url(headers['X-Aid-Sig']!);
    expect(estBasse(sig)).toBe(true);
    // La signature porte sur le corps effectivement envoyé.
    expect(
      await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        publiqueRelais,
        sig,
        octetsRequeteRelais({
          methode: 'POST',
          chemin: `/reponses/${demande.id}`,
          heure: headers['X-Aid-Heure']!,
          hachageCorps: await hacher(new TextEncoder().encode(requete!.body as string)),
        }),
      ),
    ).toBe(true);
  },
);
test.each([null, -257, 'empreinte'] as const)(
  'enregistrement refusé sans stockage : %s',
  async (cas) => {
    memoire.donnees.clear();
    window.history.replaceState(null, '', '/pda/enregistrer');
    create.mockResolvedValue({
      rawId: new Uint8Array([1]).buffer,
      response: {
        getPublicKey: () => (cas === null ? null : new Uint8Array([1]).buffer),
        getPublicKeyAlgorithm: () => (cas === -257 ? -257 : -7),
      },
    });
    reseau.mockImplementation(
      async (url) =>
        new Response(
          JSON.stringify(String(url).endsWith('/pda') ? { id: 'test', empreinte: 'FAUSSE' } : {}),
        ),
    );
    render(<AppPda />);
    fireEvent.change(await screen.findByLabelText('Nom de cet appareil'), {
      target: { value: 'Téléphone' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer cet appareil' }));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toMatch(
        cas === null ? /clé publique/ : cas === -257 ? /ES256/ : /empreintes diffèrent/,
      ),
    );
    expect(memoire.donnees.size).toBe(0);
    if (cas !== 'empreinte') expect(reseau.mock.calls).toHaveLength(1);
  },
);

test('lecture signée en s bas, sans cookies ni redirection', async () => {
  await pda.requeteRelais('https://example.com', local, '/demandes');
  const [, options] = reseau.mock.calls[0]!;
  expect(options).toMatchObject({
    method: 'GET',
    credentials: 'omit',
    redirect: 'error',
    cache: 'no-store',
  });
  const headers = options!.headers as Record<string, string>;
  const signature = decoderBase64url(headers['X-Aid-Sig']!);
  expect(estBasse(signature)).toBe(true);
  expect(
    await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publiqueRelais,
      signature,
      octetsRequeteRelais({
        methode: 'GET',
        chemin: '/demandes',
        heure: headers['X-Aid-Heure']!,
        hachageCorps: await hacher(new Uint8Array()),
      }),
    ),
  ).toBe(true);
});
test.each([401, 429])('erreur relais %s affichée sans contenu reçu', async (status) => {
  reseau.mockResolvedValue(new Response('contenu hostile', { status }));
  render(<AppPda />);
  await waitFor(() =>
    expect(screen.getByRole('status').textContent).toMatch(
      status === 401 ? /pas encore activé/ : /Trop de demandes/,
    ),
  );
  expect(screen.queryByText('contenu hostile')).toBeNull();
});
test('annulation passkey, puis réponse envoyée et demande retirée', async () => {
  get.mockRejectedValueOnce(new DOMException('annulation', 'NotAllowedError'));
  render(<AppPda />);
  fireEvent.click(await screen.findByRole('button', { name: 'Refuser' }));
  expect(await screen.findByText('Passkey annulée')).toBeTruthy();
  const octets = new Uint8Array([1]).buffer;
  get.mockResolvedValue({
    rawId: octets,
    response: { authenticatorData: octets, clientDataJSON: octets, signature: octets },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Refuser' }));
  expect(await screen.findByText('Réponse envoyée')).toBeTruthy();
  expect(screen.queryByText(demande.sujet)).toBeNull();
  expect(JSON.parse(reseau.mock.calls.at(-1)![1]!.body as string).numero).toBeNull();
});

test('le vrai point d’entrée /pda évite detecterMode et toutes les API', async () => {
  const mode = await import('../../web/src/data/appareil.js');
  const detecter = vi.spyOn(mode, 'detecterMode');
  const afficher = vi.fn();
  vi.doMock('react-dom/client', () => ({
    createRoot: () => ({ render: afficher, unmount: vi.fn() }),
  }));
  const racine = document.createElement('div');
  racine.id = 'root';
  document.body.append(racine);
  try {
    await import('../../web/src/main.js');
    expect(detecter).not.toHaveBeenCalled();
    expect(reseau).not.toHaveBeenCalled();
    expect(afficher.mock.calls[0]![0].type).toBe(AppPda);
  } finally {
    racine.remove();
  }
});

test('enregistrement réussi : empreinte comparée et clé privée non extractible conservée', async () => {
  memoire.donnees.clear();
  window.history.replaceState(null, '', '/pda/enregistrer');
  create.mockResolvedValue({
    rawId: decoderBase64url(credId).buffer,
    response: {
      getPublicKey: () => new Uint8Array([1, 2]).buffer,
      getPublicKeyAlgorithm: () => -7,
    },
  });
  reseau.mockImplementation(async (url, options) => {
    if (String(url).endsWith('/pda')) {
      const cles = JSON.parse(options!.body as string);
      return new Response(
        JSON.stringify({ id: 'pda_nouveau', empreinte: await empreintePda(cles) }),
      );
    }
    return new Response('{}');
  });
  render(<AppPda />);
  fireEvent.change(await screen.findByLabelText('Nom de cet appareil'), {
    target: { value: 'Téléphone' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Enregistrer cet appareil' }));
  expect(
    await screen.findByText('Compare-la sur le Mac, puis active cet appareil là-bas'),
  ).toBeTruthy();
  const conserve = await pda.stockagePda();
  expect(conserve).toMatchObject({ id: 'pda_nouveau', credId });
  expect(conserve!.cleRelais.extractable).toBe(false);
  await expect(crypto.subtle.exportKey('jwk', conserve!.cleRelais)).rejects.toThrow();
  const options = create.mock.calls[0]![0].publicKey;
  expect(options).toMatchObject({
    rp: { id: location.hostname, name: 'A-I-D' },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    attestation: 'none',
  });
  expect(options.user.id.byteLength).toBe(16);
});
