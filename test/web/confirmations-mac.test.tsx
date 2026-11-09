// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Route, Routes } from 'react-router';
import { Livraison } from '../../web/src/ecrans/Livraison.js';
import { useActionSuivie } from '../../web/src/data/livraison.js';
import { Cockpit } from '../../web/src/ui/Cockpit.js';
import { PanneauPda } from '../../web/src/ui/PanneauPda.js';
import { PanneauConfirmations } from '../../web/src/ui/PanneauConfirmations.js';
import { type Confirmation } from '../../web/src/ui/AttenteConfirmation.js';
import { json, setup, snapshot, topic, ws } from './helpers.js';

const ouverte: Confirmation = {
  id: 'confirmation_1',
  classe: 'defaut',
  resume: 'Merge du sujet',
  echeance: Date.now() + 900_000,
  etat: 'ouverte',
  resultat: null,
};
const reglage = {
  arme: true,
  armeA: Date.now(),
  desarmeA: null,
  bandeau: null,
  actions: ['merge', 'push', 'nettoyage', 'projet.retirer'].map((action) => ({
    action,
    actif: true,
  })),
};
const routes = {
  'GET /api/confirmations': json(200, { ouvertes: [ouverte], recentes: [] }),
  'GET /api/confirmations/reglage': json(200, reglage),
  'GET /api/confirmations/confirmation_1/numero': json(200, { numero: '8306' }),
};
beforeEach(() => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function Merge() {
  const merge = useActionSuivie('tp_1');
  return (
    <div>
      {merge.confirmation.attente ?? (
        <button onClick={() => void merge.lancer('topic.merge')}>Merge</button>
      )}
      {merge.echec && <p role="alert">{merge.echec}</p>}
    </div>
  );
}
function ouvrirMerge() {
  return setup(<Merge />, snapshot(), '/', {
    ...routes,
    'POST /api/topics/tp_1/actions/topic.merge': json(202, { confirmation: ouverte.id }),
  });
}
async function avancer() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
}

test('merge 202 : attente, exécution, rafraîchissement et arrêt de la relecture', async () => {
  const h = ouvrirMerge();
  fireEvent.click(screen.getByText('Merge'));
  await screen.findByText('En attente de confirmation sur le téléphone');
  expect(screen.queryByRole('button', { name: 'Merge' })).toBeNull();
  await waitFor(async () => {
    await avancer();
    expect(h.calls.some((c) => c.url === '/api/confirmations')).toBe(true);
  });
  const avant = h.calls.filter((c) => c.url === '/api/state').length;
  h.respond.set(
    'GET /api/confirmations',
    json(200, {
      ouvertes: [],
      recentes: [{ ...ouverte, etat: 'consommee', resultat: 'executee' }],
    }),
  );
  await avancer();
  expect(screen.getByText('Exécutée')).toBeTruthy();
  expect(h.calls.filter((c) => c.url === '/api/state').length).toBeGreaterThan(avant);
  const lectures = h.calls.filter((c) => c.url === '/api/confirmations').length;
  await avancer();
  expect(h.calls.filter((c) => c.url === '/api/confirmations').length).toBe(lectures);
});

test('merge : Annuler appelle DELETE et arrête l’attente', async () => {
  const h = ouvrirMerge();
  h.respond.set('DELETE /api/confirmations/confirmation_1', json(204, {}));
  fireEvent.click(screen.getByText('Merge'));
  fireEvent.click(await screen.findByRole('button', { name: 'Annuler' }));
  await screen.findByText('Annulée');
  expect(
    h.calls.some((c) => c.method === 'DELETE' && c.url === '/api/confirmations/confirmation_1'),
  ).toBe(true);
  await avancer();
  expect(screen.getByText('Annulée')).toBeTruthy();
});

test.each([
  ['perimee', 'consommee', "Périmée : l'état a changé depuis la demande"],
  [null, 'refusee', 'Refusée sur le téléphone'],
  [null, 'expiree', 'Expirée'],
  ['echouee', 'consommee', 'Échouée'],
])('merge : résultat %s / %s', async (resultat, etat, texte) => {
  const h = ouvrirMerge();
  h.respond.set(
    'GET /api/confirmations',
    json(200, { ouvertes: [], recentes: [{ ...ouverte, etat, resultat }] }),
  );
  fireEvent.click(screen.getByText('Merge'));
  await screen.findByText(texte);
});

test.each([
  [
    409,
    {
      error: 'confirmation_impossible',
      message: 'Allume le PDA et active un téléphone pour cette action',
    },
    'Allume le PDA et active un téléphone pour cette action',
  ],
  [
    422,
    { error: 'message de merge personnalisé indisponible sous confirmation' },
    'message de merge personnalisé indisponible sous confirmation',
  ],
])('merge : le refus %s conserve le message du daemon', async (statut, corps, texte) => {
  const h = ouvrirMerge();
  h.respond.set('POST /api/topics/tp_1/actions/topic.merge', json(statut, corps));
  fireEvent.click(screen.getByText('Merge'));
  expect((await screen.findByRole('alert')).textContent).toBe(texte);
});

const host = {
  actif: true,
  code: false,
  push: false,
  abonnements: 0,
  disponible: true,
  port: 4890,
  tailnet: { etat: 'running', nom: 'aid-e2e.ts.net', compte: null },
  serve: { etat: 'ok', funnel: false, interdits: [] },
  commande: '',
  raison: null,
};
function ouvrirHost() {
  return setup(<Cockpit />, snapshot(), '/', {
    ...routes,
    'GET /api/host': json(200, host),
    'GET /api/host/appareils': json(200, []),
    'GET /api/host/appairage': json(200, {
      demande: {
        id: 'appairage_1',
        etat: 'reclamee',
        expireA: new Date(Date.now() + 900_000).toISOString(),
        codeCourt: 'ABCD',
        nom: 'Téléphone',
        identite: null,
        raison: null,
      },
      identiteVerifiable: false,
    }),
    'POST /api/host/appairages': json(200, {
      demandeId: 'appairage_1',
      code: 'exemple',
      expireA: new Date(Date.now() + 900_000).toISOString(),
      url: 'https://example.com/appairer#exemple',
    }),
    'POST /api/host/appairages/appairage_1/approuver': json(202, { confirmation: ouverte.id }),
  });
}

test('approbation toujours : grand numéro local, effacé à la fin et absent du stockage et du titre', async () => {
  const titre = document.title;
  const stockage = JSON.stringify(localStorage);
  const h = ouvrirHost();
  fireEvent.click(await screen.findByRole('button', { name: 'Ajouter un appareil' }));
  fireEvent.click(await screen.findByLabelText('Appareil taggé, sans identité Tailscale'));
  fireEvent.click(screen.getByRole('button', { name: 'Approuver' }));
  const numero = await screen.findByText('8306');
  expect(numero.style.fontSize).toBe('3rem');
  expect(screen.getByText('Retape ce numéro sur le téléphone')).toBeTruthy();
  expect(JSON.stringify(localStorage)).toBe(stockage);
  expect(document.title).toBe(titre);
  h.respond.set(
    'GET /api/confirmations',
    json(200, {
      ouvertes: [],
      recentes: [{ ...ouverte, classe: 'toujours', etat: 'consommee', resultat: 'executee' }],
    }),
  );
  await avancer();
  expect(screen.queryByText('8306')).toBeNull();
  expect(screen.getByText('Exécutée')).toBeTruthy();
  expect(JSON.stringify(localStorage)).toBe(stockage);
  expect(document.title).toBe(titre);
});

test.each(['code', 'push'])(
  'allumer %s traite 202 sans remplacer l’état host par la demande',
  async (option) => {
    const h = ouvrirHost();
    h.respond.set(`PUT /api/host/${option}`, json(202, { confirmation: ouverte.id }));
    fireEvent.click(
      await screen.findByRole('switch', {
        name:
          option === 'code'
            ? 'Montrer le code aux appareils'
            : 'Notifications push sur les téléphones',
      }),
    );
    await screen.findByText('8306');
    expect(h.calls.find((c) => c.url === `/api/host/${option}`)?.body).toEqual({ actif: true });
    expect(screen.getByText('Mode host actif')).toBeTruthy();
  },
);

test('réglage : couper crée une demande, puis rallumer est direct', async () => {
  let actif = true;
  const h = setup(<PanneauConfirmations />, snapshot(), '/', {
    ...routes,
    'GET /api/confirmations/reglage': () =>
      new Response(JSON.stringify({ ...reglage, actions: [{ action: 'merge', actif }] })),
    'PUT /api/confirmations/reglage': (corps) => {
      if ((corps as { actif: boolean }).actif) {
        actif = true;
        return new Response('{}');
      }
      return new Response(JSON.stringify({ confirmation: ouverte.id }), { status: 202 });
    },
  });
  fireEvent.click(await screen.findByRole('switch', { name: 'Merge' }));
  await screen.findByText('Retape ce numéro sur le téléphone');
  actif = false;
  h.respond.set(
    'GET /api/confirmations',
    json(200, {
      ouvertes: [],
      recentes: [{ ...ouverte, resultat: 'executee', etat: 'consommee' }],
    }),
  );
  await avancer();
  expect((screen.getByRole('switch', { name: 'Merge' }) as HTMLInputElement).checked).toBe(false);
  await act(async () => {
    fireEvent.click(screen.getByRole('switch', { name: 'Merge' }));
  });
  expect(h.calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toEqual([
    { action: 'merge', actif: false },
    { action: 'merge', actif: true },
  ]);
  expect((screen.getByRole('switch', { name: 'Merge' }) as HTMLInputElement).checked).toBe(true);
});

test.each([true, false])(
  'désarmement avec réponse confirmée = %s, phrase exacte et bandeau de réarmement',
  async (confirmee) => {
    const h = setup(<PanneauConfirmations />, snapshot(), '/', {
      ...routes,
      'POST /api/confirmations/desarmer': json(
        confirmee ? 202 : 200,
        confirmee ? { confirmation: ouverte.id } : { ok: true },
      ),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Désarmer' }));
    const bouton = screen.getByRole('button', { name: 'Désarmer' }) as HTMLButtonElement;
    expect(bouton.disabled).toBe(true);
    const champ = screen.getByLabelText('Tape DÉSARMER pour confirmer');
    fireEvent.change(champ, { target: { value: 'désarmer' } });
    expect(bouton.disabled).toBe(true);
    fireEvent.change(champ, { target: { value: 'DÉSARMER' } });
    expect(bouton.disabled).toBe(false);
    h.respond.set(
      'GET /api/confirmations/reglage',
      json(200, { ...reglage, arme: false, desarmeA: Date.now(), bandeau: 'desarme' }),
    );
    fireEvent.click(bouton);
    if (confirmee) {
      await screen.findByText('8306');
      h.respond.set(
        'GET /api/confirmations',
        json(200, {
          ouvertes: [],
          recentes: [{ ...ouverte, resultat: 'executee', etat: 'consommee' }],
        }),
      );
      await avancer();
      expect(screen.queryByText('8306')).toBeNull();
    } else await screen.findByRole('button', { name: 'Réarmer' });
    expect(screen.getByText(/Confirmations désarmées le/)).toBeTruthy();
    h.respond.set('POST /api/confirmations/armer', json(200, { ok: true }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Réarmer' }));
    });
    expect(h.calls.some((c) => c.method === 'POST' && c.url === '/api/confirmations/armer')).toBe(
      true,
    );
    expect(h.calls.find((c) => c.url === '/api/confirmations/desarmer')?.body).toEqual({
      phrase: 'DÉSARMER',
    });
  },
);

test('bandeau amorçage et état non armé', async () => {
  setup(<PanneauConfirmations />, snapshot(), '/', {
    ...routes,
    'GET /api/confirmations/reglage': json(200, { ...reglage, arme: false, bandeau: 'amorcage' }),
  });
  await screen.findByText(
    'Premier appareil activé sans confirmation. Active un second téléphone pour le secours.',
  );
  expect(screen.getByText('Confirmations non armées')).toBeTruthy();
  expect(screen.getByText('Elles s’arment à l’activation du premier téléphone PDA')).toBeTruthy();
});

test('second PDA : empreinte envoyée, puis attente avec numéro', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  const h = setup(
    <PanneauPda etat={{ actif: true, relais: 'https://example.com' }} />,
    snapshot(),
    '/',
    {
      ...routes,
      'GET /api/host/pda/appareils': json(200, [
        {
          id: 'pda_2',
          nom: 'Secours',
          etat: 'attente',
          empreinte: 'ABCD-EF01',
          cree_a: '2026-11-08',
        },
      ]),
      'GET /api/host/pda/cle': json(200, { clePublique: 'exemple' }),
      'POST /api/host/pda/appareils/pda_2/activer': json(202, { confirmation: ouverte.id }),
    },
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Activer' }));
  await screen.findByText('8306');
  expect(h.calls.find((c) => c.url.endsWith('/pda_2/activer'))?.body).toEqual({
    empreinte: 'ABCD-EF01',
  });
});

test('écran Livraison : le merge 202 ferme le dialogue et remplace le bouton par l’attente', async () => {
  const tete = 'a'.repeat(40);
  const sujet = topic({ state: 'review', prNumber: 7 });
  const pr = {
    id: 'ac_pr',
    topicId: sujet.id,
    workspaceId: 'ws_1',
    action: 'pr.rafraichir',
    state: 'succeeded' as const,
    exitCode: 0,
    result: {
      number: 7,
      url: 'https://example.com/pull/7',
      state: 'OPEN',
      headRefOid: tete,
      baseRefName: 'main',
      mergeable: 'MERGEABLE',
      statusCheckRollup: [],
      reviews: [],
    },
    startedAt: '2026-11-08T10:00:00Z',
    finishedAt: '2026-11-08T10:00:01Z',
  };
  const h = setup(
    <Routes>
      <Route path="/sujets/:topicId/livraison" element={<Livraison />} />
    </Routes>,
    snapshot({ workspaces: [ws()], topics: [sujet], actions: [pr] }),
    '/sujets/tp_1/livraison',
    {
      ...routes,
      'GET /api/nav': json(200, {
        groups: [],
        placements: [],
        prefs: { reduit: false, rangement: 'etat' },
      }),
      'GET /api/memory/pages?prefix=aid%2F': json(200, { slugs: [] }),
      'GET /api/topics/tp_1/git/livraison': json(200, {
        head: tete,
        base: 'main',
        mergeBase: 'b'.repeat(40),
        files: [],
        additions: 0,
        deletions: 0,
        empreinte: 'exemple',
      }),
      'POST /api/topics/tp_1/actions/pr.rafraichir': json(202, { actionId: 'ac_pr' }),
      'POST /api/topics/tp_1/actions/topic.merge': json(202, { confirmation: ouverte.id }),
    },
  );
  const bouton = await screen.findByRole('button', { name: 'Autoriser le merge de aaaaaaa' });
  await waitFor(async () => {
    await avancer();
    expect((bouton as HTMLButtonElement).disabled).toBe(false);
  });
  fireEvent.click(bouton);
  fireEvent.click(screen.getByRole('button', { name: 'Fusionner aaaaaaa' }));
  await screen.findByText('En attente de confirmation sur le téléphone');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Autoriser le merge de aaaaaaa' })).toBeNull();
  h.respond.set(
    'GET /api/confirmations',
    json(200, {
      ouvertes: [],
      recentes: [{ ...ouverte, etat: 'consommee', resultat: 'executee' }],
    }),
  );
  const lectures = h.calls.filter((c) => c.url.endsWith('/actions/pr.rafraichir')).length;
  await avancer();
  expect(screen.getByText('Exécutée')).toBeTruthy();
  expect(h.calls.filter((c) => c.url.endsWith('/actions/pr.rafraichir')).length).toBeGreaterThan(
    lectures,
  );
});

test('faux numéro signé : motif dans l’attente et les dernières demandes', async () => {
  const h = ouvrirMerge();
  h.respond.set(
    'GET /api/confirmations',
    json(200, {
      ouvertes: [],
      recentes: [{ ...ouverte, etat: 'expiree', resultat: 'annulee', raison: 'numero' }],
    }),
  );
  fireEvent.click(screen.getByText('Merge'));
  await screen.findByText('Annulée : mauvais numéro saisi sur le téléphone');
  cleanup();
  setup(<PanneauConfirmations />, snapshot(), '/', {
    ...routes,
    'GET /api/confirmations': json(200, {
      ouvertes: [],
      recentes: [{ ...ouverte, etat: 'expiree', resultat: 'annulee', raison: 'numero' }],
    }),
  });
  await screen.findByText('Merge du sujet — Annulée : mauvais numéro saisi sur le téléphone');
});

test('le réglage mesh.ecrire fourni par le daemon porte son libellé', async () => {
  setup(<PanneauConfirmations />, snapshot(), '/', {
    ...routes,
    'GET /api/confirmations/reglage': json(200, {
      ...reglage,
      actions: [{ action: 'mesh.ecrire', actif: true }],
    }),
  });
  expect(await screen.findByRole('switch', { name: 'Écrire sur le mesh' })).toHaveProperty(
    'checked',
    true,
  );
});
