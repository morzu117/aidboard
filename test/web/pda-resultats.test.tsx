// @vitest-environment jsdom
import { createServer } from 'node:http';
import { creerRelais } from '../../src/relais/index.js';
import { generateKeyPairSync, sign, webcrypto } from 'node:crypto';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { AppPda, libelleResultat } from '../../web/src/AppPda.js';
import * as pda from '../../web/src/data/pda.js';
import {
  CONTEXTE_DEMANDE,
  decoderBase64url,
  encoderBase64url,
  hacher,
  jsonCanonique,
  octetsRequeteRelais,
  signerResultat,
  signatureBasse,
  type CorpsResultatV1,
} from '../../src/shared/pda.js';

const id = encoderBase64url(new Uint8Array(16));
const autreId = encoderBase64url(new Uint8Array(16).fill(1));
const resultat: CorpsResultatV1 = {
  v: 1,
  id,
  action: 'essai',
  resultat: 'executee',
  raison: null,
  code: null,
  emis: 1000,
};
const incertain = 'Issue incertaine, à vérifier sur le Mac';
test.each<[Partial<CorpsResultatV1>, string]>([
  [{}, 'Exécutée'],
  [{ resultat: 'echouee' }, 'Échouée'],
  [{ resultat: 'echouee', raison: 'script' }, 'Échouée (script)'],
  [{ resultat: 'echouee', code: 'connexion' }, 'Échouée (connexion)'],
  [{ resultat: 'echouee', raison: 'script', code: 'format' }, 'Échouée (script, format)'],
  [{ resultat: 'perimee' }, 'Périmée'],
  [{ resultat: 'annulee' }, 'Annulée'],
  [{ resultat: 'annulee', raison: 'numero' }, 'Annulée : numéro faux'],
  [{ resultat: 'echouee', code: 'upstream_ambiguous' }, `${incertain} (upstream_ambiguous)`],
  [{ resultat: 'echouee', code: 'delai' }, `${incertain} (delai)`],
  [{ resultat: 'echouee', code: 'interrompu' }, `${incertain} (interrompu)`],
  [{ resultat: 'echouee', raison: 'delai' }, incertain],
  [{ action: 'mesh.ecrire', raison: 'delai' }, incertain],
  [{ resultat: 'annulee', raison: 'numero', code: 'delai' }, `${incertain} (delai)`],
  [{ resultat: 'executee', raison: 'numero' }, 'Annulée : numéro faux'],
  [{ code: 'format' }, 'Exécutée (format)'],
  [{ code: 'succes' }, 'Exécutée'],
])('libellé D308/D310 : %j', (champs, attendu) => {
  const libelle = libelleResultat({ ...resultat, ...champs }, 0, 0);
  expect(libelle).toBe(attendu);
  expect(libelle).not.toMatch(/null|\(\)/);
});
test('attente et limite de 24 h', () => {
  const jour = 24 * 60 * 60_000;
  expect(libelleResultat(null, 100, 100)).toBe('En attente du résultat');
  expect(libelleResultat(null, 100, 100 + jour)).toBe('En attente du résultat');
  expect(libelleResultat(null, 100, 101 + jour)).toBe('Résultat non reçu, à lire sur le Mac');
});

const daemon = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = daemon.publicKey.export({ format: 'jwk' });
const cle = encoderBase64url(
  new Uint8Array([4, ...decoderBase64url(jwk.x!), ...decoderBase64url(jwk.y!)]),
);
const signer = (octets: Uint8Array) =>
  sign('sha256', octets, { key: daemon.privateKey, dsaEncoding: 'ieee-p1363' });
let appareil: pda.PdaLocal;
let publiqueRelais: CryptoKey;
const reseau = vi.fn<typeof fetch>();
const fetchReel = globalThis.fetch;
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('fetch', reseau);
  const paire = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
    'sign',
    'verify',
  ]);
  publiqueRelais = paire.publicKey;
  appareil = { id: 'appareil-test', credId: 'AQ', cleRelais: paire.privateKey };
  window.history.replaceState(null, '', '/pda');
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  reseau.mockReset();
});
test('GET /resultats signé, enveloppes forgées, altérées et demande rejetées', async () => {
  const valide = signerResultat(resultat, signer)!;
  const corpsDemande = new TextEncoder().encode(
    jsonCanonique({
      v: 1,
      id,
      action: 'essai',
      sujet: 'Essai',
      numero: '1234',
      emise: 0,
      echeance: 1000,
    }),
  );
  const demande = {
    corps: encoderBase64url(corpsDemande),
    sig: encoderBase64url(
      signer(new Uint8Array([...new TextEncoder().encode(CONTEXTE_DEMANDE), ...corpsDemande])),
    ),
  };
  reseau.mockResolvedValue(
    new Response(
      JSON.stringify({
        resultats: [
          null,
          {},
          { ...valide, sig: encoderBase64url(new Uint8Array(64)) },
          {
            ...valide,
            corps: encoderBase64url(
              new TextEncoder().encode(jsonCanonique({ ...resultat, id: autreId })),
            ),
          },
          demande,
          { ...valide, id: autreId },
        ],
      }),
    ),
  );
  expect(await pda.lireResultats('https://example.com', appareil, cle)).toEqual([resultat]);
  const [url, options] = reseau.mock.calls[0]!;
  expect(url).toBe('https://example.com/resultats');
  expect(options).toMatchObject({
    method: 'GET',
    credentials: 'omit',
    redirect: 'error',
    cache: 'no-store',
  });
  const headers = options!.headers as Record<string, string>;
  expect(
    await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publiqueRelais,
      decoderBase64url(headers['X-Aid-Sig']!),
      octetsRequeteRelais({
        methode: 'GET',
        chemin: '/resultats',
        heure: headers['X-Aid-Heure']!,
        hachageCorps: await hacher(new Uint8Array()),
      }),
    ),
  ).toBe(true);
  expect(headers['X-Aid-Appareil']).toBe(appareil.id);
  expect(headers['X-Aid-Sig']).toBeTruthy();
});
test.each(['reseau', 'json', 'liste', 'taille'] as const)(
  'lecture défaillante : %s',
  async (cas) => {
    if (cas === 'reseau') reseau.mockRejectedValue(new Error('indisponible'));
    else
      reseau.mockResolvedValue(
        new Response(cas === 'json' ? '{' : cas === 'liste' ? '{}' : ' '.repeat(65537)),
      );
    expect(await pda.lireResultats('https://example.com', appareil, cle)).toEqual([]);
  },
);

test.each([
  ['tableau nu', (enveloppe: unknown) => [enveloppe]],
  ['clé supplémentaire', (enveloppe: unknown) => ({ resultats: [enveloppe], autre: true })],
  ['champ absent', () => ({})],
  ['champ non tableau', () => ({ resultats: {} })],
  ['plus de 50 résultats', (enveloppe: unknown) => ({ resultats: Array(51).fill(enveloppe) })],
  ['null', () => null],
] as const)('forme rejetée : %s', async (_nom, fabriquer) => {
  reseau.mockResolvedValue(
    new Response(JSON.stringify(fabriquer(signerResultat(resultat, signer)!))),
  );
  expect(await pda.lireResultats('https://example.com', appareil, cle)).toEqual([]);
});

test('vrai relais : publication signée puis lecture par le téléphone', async () => {
  const serveur = createServer(
    creerRelais({
      origineApp: 'https://example.com',
      cleDaemon: cle,
      journal: vi.fn(),
    }),
  );
  await new Promise<void>((resolve) => serveur.listen(0, '127.0.0.1', resolve));
  const adresse = serveur.address();
  if (!adresse || typeof adresse === 'string') throw new Error('Adresse du relais absente');
  const relais = `http://127.0.0.1:${adresse.port}`;
  vi.stubGlobal('fetch', fetchReel);
  async function publier(chemin: string, contenu: unknown) {
    const corps = JSON.stringify(contenu);
    const heure = String(Date.now());
    const signature = signatureBasse(
      signer(
        octetsRequeteRelais({
          methode: 'PUT',
          chemin,
          heure,
          hachageCorps: await hacher(new TextEncoder().encode(corps)),
        }),
      ),
    );
    const reponse = await fetchReel(`${relais}${chemin}`, {
      method: 'PUT',
      body: corps,
      headers: { 'X-Aid-Heure': heure, 'X-Aid-Sig': encoderBase64url(signature) },
    });
    expect(reponse.status).toBe(204);
  }
  try {
    const { kty, crv, x, y } = await crypto.subtle.exportKey('jwk', publiqueRelais);
    await publier('/autorises', { appareils: [{ id: appareil.id, cle: { kty, crv, x, y } }] });
    await publier(`/resultats/${id}`, signerResultat(resultat, signer));
    expect(await pda.lireResultats(relais, appareil, cle)).toEqual([resultat]);
  } finally {
    serveur.closeAllConnections();
    await new Promise<void>((resolve) => serveur.close(() => resolve()));
  }
});

function preparer() {
  vi.spyOn(pda, 'chargerCodePda').mockResolvedValue({
    CLE_DAEMON: cle,
    RELAIS: 'https://example.com',
  });
  vi.spyOn(pda, 'stockagePda').mockResolvedValue(appareil);
  vi.spyOn(pda, 'requeteRelais').mockResolvedValue(new Response('[]'));
  vi.spyOn(pda, 'fabriquerReponse').mockResolvedValue(
    {} as Awaited<ReturnType<typeof pda.fabriquerReponse>>,
  );
  vi.spyOn(pda, 'lireDemandes').mockResolvedValue({
    demandes: [
      {
        corps: '',
        demande: {
          v: 1,
          id,
          action: 'essai',
          sujet: 'Essai affiché',
          numero: '1234',
          emise: Date.now(),
          echeance: Date.now() + 300000,
        },
      },
    ],
    illisibles: 0,
  });
  return vi.spyOn(pda, 'lireResultats').mockResolvedValue([]);
}
async function confirmer() {
  const champ = await screen.findByLabelText('Retape le numéro');
  await waitFor(() =>
    expect((screen.getByRole('button', { name: 'Actualiser' }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
  fireEvent.change(champ, { target: { value: '1234' } });
  fireEvent.click(screen.getByRole('button', { name: 'Confirmer' }));
  await screen.findByText('Réponse envoyée');
}
test('oui conservé, relectures à +20 et +45 s, nettoyage au démontage', async () => {
  const lire = preparer();
  const vue = render(<AppPda />);
  await screen.findByLabelText('Retape le numéro');
  await waitFor(() =>
    expect((screen.getByRole('button', { name: 'Actualiser' }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
  vi.useFakeTimers();
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Retape le numéro'), { target: { value: '1234' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmer' }));
  });
  expect(screen.getByText('En attente du résultat')).toBeTruthy();
  expect(lire).toHaveBeenCalledTimes(1);
  await act(() => vi.advanceTimersByTimeAsync(19999));
  expect(lire).toHaveBeenCalledTimes(1);
  lire.mockResolvedValue([resultat]);
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(lire).toHaveBeenCalledTimes(2);
  expect(screen.getByText('Exécutée')).toBeTruthy();
  await act(() => vi.advanceTimersByTimeAsync(24999));
  expect(lire).toHaveBeenCalledTimes(2);
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(lire).toHaveBeenCalledTimes(3);
  vue.unmount();
  expect(vi.getTimerCount()).toBe(0);
});
test('minuteries encore pendantes nettoyées au démontage', async () => {
  const lire = preparer();
  const vue = render(<AppPda />);
  await screen.findByLabelText('Retape le numéro');
  await waitFor(() =>
    expect((screen.getByRole('button', { name: 'Actualiser' }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
  vi.useFakeTimers();
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Retape le numéro'), { target: { value: '1234' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmer' }));
  });
  expect(vi.getTimerCount()).toBe(2);
  vue.unmount();
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(45000);
  expect(lire).toHaveBeenCalledTimes(1);
});
test('non absent des réponses récentes', async () => {
  preparer();
  render(<AppPda />);
  const bouton = await screen.findByRole('button', { name: 'Refuser' });
  await waitFor(() => expect((bouton as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(bouton);
  await screen.findByText('Réponse envoyée');
  expect(screen.queryByText('Réponses récentes')).toBeNull();
});
test('id inconnu : action et heure emis, aucun résumé', async () => {
  preparer().mockResolvedValue([resultat]);
  vi.mocked(pda.lireDemandes).mockResolvedValue({ demandes: [], illisibles: 0 });
  render(<AppPda />);
  const action = await screen.findByRole('heading', { name: 'essai' });
  const article = action.closest('article')!;
  expect(within(article).getByText('Exécutée')).toBeTruthy();
  expect(article.querySelector('time')?.dateTime).toBe(new Date(resultat.emis).toISOString());
  expect(article.querySelectorAll('p')).toHaveLength(1);
});
test('action différente rejetée, id signé utilisé malgré id externe et ordre inverse', async () => {
  const lire = preparer();
  render(<AppPda />);
  await confirmer();
  lire.mockResolvedValue([{ ...resultat, action: 'push' }]);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  fireEvent(document, new Event('visibilitychange'));
  await waitFor(() => expect(lire).toHaveBeenCalledTimes(2));
  expect(screen.queryByText('Exécutée')).toBeNull();
  lire.mockResolvedValue([
    { ...resultat, id: autreId, resultat: 'perimee' },
    { ...resultat, idExterne: autreId } as CorpsResultatV1,
  ]);
  fireEvent(document, new Event('visibilitychange'));
  const executee = await screen.findByText('Exécutée');
  expect(within(executee.closest('article')!).getByText('Demande d’essai')).toBeTruthy();
  expect(
    within(screen.getByText('Périmée').closest('article')!).queryByText('Demande d’essai'),
  ).toBeNull();
  expect(document.querySelector('img')).toBeNull();
});
