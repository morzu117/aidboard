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
  hacher,
} from '../../src/shared/pda.js';
import { verifierAssertion } from '../../src/daemon/pda/webauthn.js';
import {
  CLASSE_ACTION,
  resumeAction,
  type CorpsDemandeV2,
  type ParamsAction,
} from '../../src/shared/confirmations.js';
import { indexedDBMemoire } from './indexedDBMemoire.js';

const encode = (v: Uint8Array) => encoderBase64url(v);
const daemon = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = daemon.publicKey.export({ format: 'jwk' });
const cle = encode(new Uint8Array([4, ...decoderBase64url(jwk.x!), ...decoderBase64url(jwk.y!)]));
const credId = encode(new Uint8Array([1, 2, 3]));
let local: pda.PdaLocal;
let memoire: ReturnType<typeof indexedDBMemoire>;
let enveloppe: { corps: string; sig: string };
let demande: CorpsDemandeV2;
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
  local = { id: 'pda_test', credId, cleRelais: paire.privateKey };
  await pda.stockagePda(local);
  vi.spyOn(pda, 'chargerCodePda').mockResolvedValue({
    CLE_DAEMON: cle,
    RELAIS: 'https://example.com',
  });
  choisir({ action: 'desarmement', params: {} });
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

function choisir(entree: ParamsAction) {
  demande = {
    ...entree,
    v: 2,
    id: encode(new Uint8Array(16)),
    classe: CLASSE_ACTION[entree.action],
    resume: resumeAction(entree.action, entree.params),
    numero: CLASSE_ACTION[entree.action] === 'toujours' ? null : '1234',
    emise: Date.now(),
    echeance: Date.now() + 900000,
  } as CorpsDemandeV2;
}
const tete = 'abcdef0'.padEnd(40, '1');
const cas: [ParamsAction, string[]][] = [
  [
    {
      action: 'merge',
      params: {
        topicId: 'interne_topic',
        depot: 'exemple/depot',
        pr: 42,
        tete,
        strategie: 'squash',
        supprimerBranche: true,
        nettoyer: false,
        teteNettoyage: null,
      },
    },
    [
      'Dépôt : exemple/depot',
      'PR : 42',
      'Tête : abcdef0',
      'Stratégie : squash',
      'Branche supprimée : oui',
      'Nettoyage ensuite : non',
    ],
  ],
  [
    {
      action: 'push',
      params: { topicId: 'interne_topic', branche: 'sujet/test', tete, distante: null },
    },
    ['Branche : sujet/test', 'Tête : abcdef0', 'Distante : nouvelle branche'],
  ],
  [
    {
      action: 'push',
      params: { topicId: 'interne_topic', branche: 'sujet/test', tete, distante: tete },
    },
    ['Distante : abcdef0'],
  ],
  [
    {
      action: 'nettoyage',
      params: {
        topicId: 'interne_topic',
        branche: 'sujet/test',
        tete: null,
        etat: 'termine',
        nonFusionnes: 3,
        sale: 'force',
      },
    },
    [
      'Branche : sujet/test',
      'Tête : sans branche',
      'Commits non fusionnés perdus : 3',
      'Modifications locales : perdues',
    ],
  ],
  [
    {
      action: 'nettoyage',
      params: {
        topicId: 'interne_topic',
        branche: 'sujet/test',
        tete,
        etat: 'termine',
        nonFusionnes: 0,
        sale: 'stash',
      },
    },
    ['Tête : abcdef0', 'Modifications locales : mises de côté'],
  ],
  [
    {
      action: 'nettoyage',
      params: {
        topicId: 'interne_topic',
        branche: 'sujet/test',
        tete,
        etat: 'termine',
        nonFusionnes: null,
        sale: 'refuser',
      },
    },
    ['Modifications locales : refusées'],
  ],
  [
    {
      action: 'projet.retirer',
      params: { workspaceId: 'interne_workspace', racine: '/exemple/projet' },
    },
    ['Racine : /exemple/projet'],
  ],
  ...[true, false].map((sansIdentite): [ParamsAction, string[]] => [
    {
      action: 'appairage',
      params: {
        appairageId: 'interne_appairage',
        nom: 'Téléphone',
        hIdentite: sansIdentite ? null : 'h'.repeat(43),
        sansIdentite,
      },
    },
    ['Nom : Téléphone', ...(sansIdentite ? ['Sans identité Tailscale'] : [])],
  ]),
  [
    {
      action: 'pda.activer',
      params: { appareilId: 'interne_appareil', nom: 'Téléphone', empreinte: 'ABCD-EFGH' },
    },
    ['Nom : Téléphone', 'Empreinte : ABCD-EFGH'],
  ],
  [{ action: 'host.option', params: { option: 'code', actif: true } }, []],
  [{ action: 'reglage', params: { action: 'merge', actif: false } }, []],
  [{ action: 'desarmement', params: {} }, ['Les actions ne demanderont plus de confirmation']],
  [{ action: 'essai', params: {} }, []],
];
test.each(cas)('affichage v2 %j', async (entree, lignes) => {
  choisir(entree);
  signer();
  render(<AppPda />);
  expect(await screen.findByRole('heading', { name: demande.resume })).toBeTruthy();
  for (const ligne of lignes) expect(screen.getByText(ligne)).toBeTruthy();
  expect(document.body.textContent).not.toMatch(
    /interne_|hIdentite|topicId|workspaceId|appareilId|appairageId/,
  );
  expect(document.body.textContent).not.toContain('h'.repeat(43));
});
test.each(['<img src=x onerror=alert(1)>', 'nom\u202e', 'nom\u2066'])(
  'nom refusé : %s',
  async (nom) => {
    choisir({
      action: 'appairage',
      params: {
        appairageId: 'interne_appairage',
        nom: 'Valide',
        hIdentite: null,
        sansIdentite: true,
      },
    });
    if (demande.action !== 'appairage') throw new Error('Action inattendue');
    demande.params.nom = nom;
    demande.resume = `Approuver l'appareil ${nom}`;
    signer();
    render(<AppPda />);
    expect(await screen.findByText('1 demande illisible ignorée')).toBeTruthy();
    expect(document.querySelector('section')).toBeNull();
    expect(document.querySelector('img')).toBeNull();
    expect(document.body.textContent).not.toContain(nom);
  },
);
test('toujours : quatre chiffres, défi exact, envoi et vérification Node', async () => {
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
  render(<AppPda />);
  const champ = await screen.findByLabelText('Retape le numéro affiché sur le Mac');
  const bouton = screen.getByRole('button', { name: 'Confirmer' }) as HTMLButtonElement;
  for (const valeur of ['', '123', 'abcd', '12345']) {
    fireEvent.change(champ, { target: { value: valeur } });
    expect(bouton.disabled).toBe(true);
  }
  fireEvent.change(champ, { target: { value: '5678' } });
  expect(bouton.disabled).toBe(false);
  fireEvent.click(bouton);
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Réponse envoyée'));
  const hDemande = await hacher(decoderBase64url(enveloppe.corps));
  expect(get.mock.calls[0]![0].publicKey.challenge).toEqual(
    await defiReponse({
      id: demande.id,
      hDemande,
      appareil: local.id,
      echeance: demande.echeance,
      valeur: 'oui',
      numero: '5678',
    }),
  );
  const envoi = reseau.mock.calls.find(([, options]) => options?.method === 'POST')!;
  const reponse = JSON.parse(envoi[1]!.body as string);
  expect(reponse.numero).toBe('5678');
  const contexte = {
    appareil: {
      id: local.id,
      credId,
      clePublique: encode(passkey.publicKey.export({ format: 'der', type: 'spki' })),
      actif: true,
    },
    demande: { id: demande.id, numero: null, echeance: demande.echeance, hDemande },
    origine: location.origin,
    rpId: location.hostname,
    maintenant: Date.now(),
    numeroAttendu: '5678',
  };
  expect(await verifierAssertion(reponse, contexte)).toEqual({ ok: true, valeur: 'oui' });
  expect(await verifierAssertion(reponse, { ...contexte, numeroAttendu: '9999' })).toMatchObject({
    ok: false,
  });
});

for (const action of ['mesh.avis', 'mesh.avis.motion', 'mesh.avis.baseline-absent'] as const) {
  test(`${action} : paramètres signés affichés en texte`, async () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const texte = `<<<QUESTION-abcd1234\n${hostile}\nQUESTION-abcd1234>>>`;
    const echeances = {
      positions: '2026-11-13T12:00:00.000Z',
      rebuttal: '2026-11-13T13:00:00.000Z',
      vote: '2026-11-13T14:00:00.000Z',
    };
    const entree: ParamsAction =
      action === 'mesh.avis'
        ? {
            action,
            params: {
              params: {
                id: 'avis-exemple',
                nom: 'avis-exemple',
                sieges: [
                  { peer: 'pair-chair', role: 'chair', family: 'orchestrator' },
                  { peer: 'pair-baseline', role: 'baseline', family: 'claude' },
                  { peer: 'pair-siege', role: 'seat', family: 'gpt' },
                ],
                carte: 24,
                echeances,
                texte,
              },
            },
          }
        : action === 'mesh.avis.motion'
          ? {
              action,
              params: { params: { id: 'avis-exemple', canal: 'canal-exemple', texte, echeances } },
            }
          : {
              action,
              params: {
                params: {
                  id: 'avis-exemple',
                  canal: `canal-${hostile}`,
                  motion: 1,
                  raison: "baseline absent à l'échéance, déclaré par le chair",
                },
              },
            };
    choisir(entree);
    signer();
    render(<AppPda />);
    if (entree.action === 'mesh.avis.baseline-absent') {
      await screen.findByText(`Canal : ${entree.params.params.canal}`);
      expect(screen.getByText('Motion : 1')).toBeTruthy();
      expect(screen.getByText(`Raison : ${entree.params.params.raison}`)).toBeTruthy();
    } else {
      if (entree.action === 'mesh.avis') {
        await screen.findByText('Salle : avis-exemple');
        expect(screen.getByText('Carte : 24')).toBeTruthy();
        for (const ligne of [
          'pair-chair — président — orchestrator',
          'pair-baseline — baseline — claude',
          'pair-siege — siège — gpt',
        ])
          expect(screen.getByText(ligne)).toBeTruthy();
      } else await screen.findByText('Canal : canal-exemple');
      for (const [tour, date] of Object.entries(echeances))
        expect(
          screen.getByText(`Échéance ${tour} : ${new Date(date).toLocaleString('fr-FR')}`),
        ).toBeTruthy();
      expect(screen.getByText('Texte de la motion :')).toBeTruthy();
      const motion = screen.getByText(texte, { normalizer: (valeur) => valeur });
      expect(motion.textContent).toBe(texte);
      expect(motion.style.whiteSpace).toBe('pre-wrap');
    }
    expect(document.querySelector('img')).toBeNull();
  });
}
