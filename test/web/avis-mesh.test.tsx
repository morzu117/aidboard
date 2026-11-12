// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import type { MeshState } from '../../src/shared/model.js';
import {
  demanderAvisMesh,
  lireAvisMesh,
  type ResultatAvisMesh,
} from '../../web/src/data/avis-mesh.js';
import { AidClient } from '../../web/src/data/client.js';
import { DemanderAvis } from '../../web/src/ui/DemanderAvis.js';
import { DemandesAvisMesh } from '../../web/src/ui/DemandesAvisMesh.js';
import { TableauAvisMesh } from '../../web/src/ecrans/TableauAvisMesh.js';
import { FakeSocket, json, setup, snapshot } from './helpers.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const monitor: MeshState = {
  ecritures: false,
  proxyConfigure: false,
  superviseur: null,
  connected: true,
  tailscale: 'running',
  monitor: 'running',
  pending: 0,
  since: null,
  cell: 'peer-local',
};
const etat = { enCours: false, depuis: null, budgetUsd: 0.5 };
const date = '2026-11-12T12:00:00.000Z';
const demande = { id: 'demande/1', etat: 'ouverte', date, cells: ['pair-1', 'pair-2'], carte: 24 };
const hostile = '<img src=x onerror=alert(1)> javascript:alert(1)';
const resultat: ResultatAvisMesh = {
  format: 'aid-avis-mesh/1',
  phase: 'vote',
  echeances: { positions: date, rebuttal: date, vote: date },
  baseline: null,
  sous_questions: [{ n: 1, texte: 'Question' }],
  avis: (
    ['ok', 'scelle', 'absent', 'attendu', 'abstention', 'secret_suspecte', 'invalide'] as const
  ).map((etat, i) => ({
    i,
    cell: `pair-${i + 1}`,
    etat,
    brut: etat === 'invalide' ? hostile : null,
    reponses: etat === 'ok' ? [{ n: 1, verdict: 'oui', justification: hostile }] : [],
    vote: etat === 'ok' ? 'scelle' : null,
  })),
  accord: [{ n: 1, accord: 'insuffisant', verdict: null, compte: {} }],
  rebuttals: [{ cell: 'pair-1', texte: hostile }],
};
async function boite(connected = true) {
  const h = setup(
    <DemanderAvis etat={etat} onClose={() => {}} />,
    snapshot({
      mesh: { state: { ...monitor, connected }, inbox: [], tailscaleManage: false },
    }),
    '/',
    {
      'GET /api/avis-mesh/config': json(200, {
        cellAid: 'peer-local',
        baseline: 'pair-baseline',
        familles: {
          'pair-baseline': 'claude',
          'pair-1': 'gemini',
          'pair-2': 'gpt',
          'pair-3': 'grok',
          'pair-4': 'meta',
          'pair-5': 'cursor',
        },
      }),
      'GET /api/swarph/cells': json(200, {
        monitor,
        peers: {
          ok: true,
          data: ['peer-local', ...Array.from({ length: 9 }, (_, i) => `pair-${i + 1}`)].map(
            (nom) => ({ nom, version: '1' }),
          ),
        },
      }),
      'GET /api/board/cards/24': json(200, {
        card: { ok: true, data: { id: 24, title: 'Titre de vérification' } },
      }),
      'GET /api/board/cards/99': json(200, { card: { ok: false } }),
      'POST /api/avis-mesh': json(200, demande),
    },
  );
  await waitFor(() => expect(FakeSocket.all.length).toBeGreaterThan(0));
  await act(async () => FakeSocket.all[0]!.open());
  if (connected) {
    expect(screen.getByLabelText('N')).toBeTruthy();
    expect(h.calls.some((c) => c.url.endsWith('/cells'))).toBe(false);
    await userEvent.click(await screen.findByRole('button', { name: 'Au mesh' }));
    await screen.findByLabelText('pair-1');
  }
  return h;
}
const envoyer = () => screen.getByRole('button', { name: 'Envoyer' }) as HTMLButtonElement;
async function remplir() {
  fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'Question' } });
  await userEvent.click(screen.getByLabelText('pair-1'));
  await userEvent.click(screen.getByLabelText('pair-2'));
  fireEvent.change(screen.getByLabelText('Numéro de carte'), { target: { value: '24' } });
  await screen.findByText('Titre de vérification');
  await userEvent.click(screen.getByRole('button', { name: 'Confirmer la carte' }));
}
test('bascule cachée hors connexion, Mac par défaut sans lecture des pairs', async () => {
  const h = await boite(false);
  expect(screen.queryByText('Au mesh')).toBeNull();
  expect(screen.getByLabelText('N')).toBeTruthy();
  expect(h.calls.filter((c) => c.url.includes('/cells'))).toHaveLength(0);
});
test('2 à 8 cells, cell locale exclue et carte inconnue bloquante', async () => {
  await boite();
  expect(screen.queryByLabelText('peer-local')).toBeNull();
  await remplir();
  expect(envoyer().disabled).toBe(false);
  await userEvent.click(screen.getByLabelText('pair-2'));
  expect(envoyer().disabled).toBe(true);
  expect(screen.getByText('Choisis de 2 à 8 cells.')).toBeTruthy();
  await userEvent.click(screen.getByLabelText('pair-2'));
  fireEvent.change(screen.getByLabelText('Numéro de carte'), { target: { value: '99' } });
  await screen.findByText('carte inconnue');
  expect(envoyer().disabled).toBe(true);
  expect(
    (screen.getByRole('button', { name: 'Confirmer la carte' }) as HTMLButtonElement).disabled,
  ).toBe(true);
});
for (const [question, raison] of [
  ['<<<QUESTION-test', 'marqueur de citation'],
  ['QUESTION>>>', 'marqueur de citation'],
  ['a'.repeat(8001), 'texte trop long'],
] as const) {
  test(`question refusée : ${raison}, ${question.length} caractères`, async () => {
    const h = await boite();
    await remplir();
    fireEvent.change(screen.getByLabelText('Question'), { target: { value: question } });
    expect(screen.getByText(`Question refusée : ${raison}`)).toBeTruthy();
    expect(envoyer().disabled).toBe(true);
    expect(h.calls.some((c) => c.method === 'POST')).toBe(false);
  });
}
test('échéances par défaut et bornes, trois tours obligatoires puis corps exact', async () => {
  const h = await boite();
  await remplir();
  const positions = screen.getByLabelText('Durée positions (heures)');
  expect((positions as HTMLInputElement).value).toBe('24');
  for (const valeur of ['0', '169']) {
    fireEvent.change(positions, { target: { value: valeur } });
    expect(envoyer().disabled).toBe(true);
  }
  fireEvent.change(positions, { target: { value: '1' } });

  fireEvent.change(screen.getByLabelText('Durée vote (heures)'), { target: { value: '168' } });
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(date));
  await userEvent.click(envoyer());
  await screen.findByText('Demande demande/1 — Ouverte');
  expect(h.calls.find((c) => c.method === 'POST')?.body).toEqual({
    mesh: 'principal',
    question: 'Question',
    cells: ['pair-1', 'pair-2'],
    carte: 24,
    echeances: {
      positions: '2026-11-12T13:00:00.000Z',
      rebuttal: '2026-11-12T14:00:00.000Z',
      vote: '2026-11-19T14:00:00.000Z',
    },
  });
});
test('client : confirmation, corps exact, id encodé et 404 rejetée normalement', async () => {
  const fetchImpl = vi.fn(
    async (_url: string, _init?: RequestInit) => (
      void _url,
      void _init,
      new Response(JSON.stringify(demande))
    ),
  );
  const client = new AidClient({ fetchImpl: fetchImpl as typeof fetch });
  const corps = {
    question: 'Question',
    cells: demande.cells,
    carte: 24,
    echeances: { positions: date, rebuttal: date, vote: date },
  };
  await demanderAvisMesh(corps, client);
  const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('/api/avis-mesh');
  expect(init.method).toBe('POST');
  expect(init.headers).toMatchObject({ 'X-AID-Confirm': 'avis' });
  expect(JSON.parse(String(init.body))).toEqual({ ...corps, mesh: 'principal' });
  await lireAvisMesh('demande/1 ?', client);
  expect(fetchImpl.mock.calls[1]?.[0]).toBe('/api/avis-mesh/demande%2F1%20%3F');
  fetchImpl.mockImplementation(
    async () => new Response(JSON.stringify({ error: 'route absente' }), { status: 404 }),
  );
  await expect(lireAvisMesh('id', client)).rejects.toThrow('route absente');
});
test('sept états, vote scellé conservant la position et bulletins hostiles en texte', () => {
  render(<TableauAvisMesh resultat={resultat} />);
  for (const libelle of [
    'ok',
    'scellé par le gateway',
    'absent',
    'en attente',
    'abstention',
    'secret suspecté',
    'invalide',
  ])
    expect(screen.getAllByText(libelle).length).toBeGreaterThan(0);
  const colonne = screen.getAllByRole('columnheader')[1]!;
  expect(colonne.textContent).toContain('pair-1');
  expect(colonne.textContent).toContain('Vote : scellé par le gateway');
  expect(screen.getByText('oui')).toBeTruthy();
  expect(screen.getByText('Phase : vote')).toBeTruthy();
  expect(screen.getAllByText(date)).toHaveLength(3);
  expect(screen.getByText('insuffisant')).toBeTruthy();
  expect(screen.getAllByText(hostile)).toHaveLength(2);
  expect(document.querySelector('img, a, script')).toBeNull();
});
test('liste : date, cells, carte, état, ouverture et Relire sans POST', async () => {
  const h = setup(<DemandesAvisMesh />, snapshot(), '/', {
    'GET /api/avis-mesh': json(200, { demandes: [demande] }),
    'GET /api/avis-mesh/demande%2F1': json(200, resultat),
  });
  await waitFor(() => expect(FakeSocket.all.length).toBeGreaterThan(0));
  await act(async () => FakeSocket.all[0]!.open());
  const bouton = await screen.findByRole('button', { name: /pair-1, pair-2 — Carte 24 — Ouverte/ });
  expect(bouton.querySelector('time')?.dateTime).toBe(date);
  await userEvent.click(bouton);
  await screen.findByRole('table');
  await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Relire' }));
  await waitFor(() =>
    expect(h.calls.filter((c) => c.url === '/api/avis-mesh/demande%2F1')).toHaveLength(2),
  );
  expect(h.calls.some((c) => c.method === 'POST')).toBe(false);
});
test('404 du formulaire dans le chemin habituel d’erreur', async () => {
  const h = await boite();
  await remplir();
  h.respond.set('POST /api/avis-mesh', json(404, { error: 'route absente' }));
  await userEvent.click(envoyer());
  expect((await screen.findByRole('alert')).textContent).toBe('route absente');
  expect(envoyer().disabled).toBe(false);
});

test('envoi par défaut : positions à 24 h, rebuttal et vote à 1 h', async () => {
  const h = await boite();
  await remplir();
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(date));
  await userEvent.click(envoyer());
  await screen.findByText('Demande demande/1 — Ouverte');
  expect(h.calls.find((c) => c.method === 'POST')?.body).toEqual({
    mesh: 'principal',
    question: 'Question',
    cells: ['pair-1', 'pair-2'],
    carte: 24,
    echeances: {
      positions: '2026-11-13T12:00:00.000Z',
      rebuttal: '2026-11-13T13:00:00.000Z',
      vote: '2026-11-13T14:00:00.000Z',
    },
  });
});

test('baseline attendu puis déclaré absent : raison hostile en texte, sans vote', () => {
  const baseline = {
    ...resultat.avis[0]!,
    cell: 'pair-baseline',
    etat: 'attendu' as const,
    reponses: [],
  };
  const vue = render(<TableauAvisMesh resultat={{ ...resultat, phase: 'rebuttal', baseline }} />);
  expect(screen.getByText('pas encore posté')).toBeTruthy();
  vue.rerender(
    <TableauAvisMesh
      resultat={{
        ...resultat,
        baseline: {
          ...baseline,
          etat: 'declare_absent',
          reason: hostile,
          by: 'pair-chair',
          at: date,
        },
      }}
    />,
  );
  const colonne = screen.getAllByRole('columnheader').at(-2)!;
  expect(colonne.textContent).toContain('baseline déclaré absent');
  expect(colonne.textContent).toContain(hostile);
  expect(colonne.textContent).not.toMatch(/vote/i);
  expect(screen.queryByText('pas encore posté')).toBeNull();
  expect(document.querySelector('img')).toBeNull();
});

test('config sans baseline bloque tout envoi', async () => {
  const h = await boite();
  h.respond.set(
    'GET /api/avis-mesh/config',
    json(200, { cellAid: 'peer-local', baseline: null, familles: {} }),
  );
  await userEvent.click(screen.getByRole('button', { name: 'Au Mac' }));
  await userEvent.click(screen.getByRole('button', { name: 'Au mesh' }));
  await screen.findByText('baseline non configuré');
  expect(envoyer().disabled).toBe(true);
});

test('famille manquante désactivée et familles comparées sans casse, baseline compris', async () => {
  const h = await boite();
  expect((screen.getByLabelText('pair-9') as HTMLInputElement).disabled).toBe(true);
  h.respond.set(
    'GET /api/avis-mesh/config',
    json(200, {
      cellAid: 'peer-local',
      baseline: 'pair-baseline',
      familles: { 'pair-baseline': 'Claude', 'pair-1': 'claude', 'pair-2': 'gpt' },
    }),
  );
  await userEvent.click(screen.getByRole('button', { name: 'Au Mac' }));
  await userEvent.click(screen.getByRole('button', { name: 'Au mesh' }));
  await screen.findByLabelText('pair-1');
  await remplir();
  expect(screen.getByText('Même famille : pair-baseline, pair-1')).toBeTruthy();
  expect(envoyer().disabled).toBe(true);
});

test('les sept états des demandes restent visibles en français, erreur exacte en texte', async () => {
  const { ETATS_AVIS } = await import('../../web/src/data/avis-mesh.js');
  setup(<DemandesAvisMesh />, snapshot(), '/', {
    'GET /api/avis-mesh': json(200, {
      demandes: Object.keys(ETATS_AVIS).map((etat, i) => ({
        ...demande,
        id: String(i),
        etat,
        erreur: { status: 409, message: hostile },
      })),
    }),
  });
  for (const libelle of Object.values(ETATS_AVIS))
    await screen.findByRole('button', { name: new RegExp(`Carte 24 — ${libelle}`) });
  expect(screen.getAllByRole('button', { name: 'Rouvrir la motion' })).toHaveLength(1);
  expect(screen.getAllByRole('alert')[0]?.textContent).toBe(`409 — ${hostile}`);
  expect(document.querySelector('img')).toBeNull();
});

test('aperçu exact des sièges, échéances et texte cité puis suivi de confirmation', async () => {
  const h = await boite();
  await remplir();
  const apercu = {
    nom: 'avis-exemple',
    sieges: [
      { peer: 'peer-local', role: 'chair', family: 'orchestrator' },
      { peer: 'pair-baseline', role: 'baseline', family: 'claude' },
      { peer: 'pair-1', role: 'seat', family: 'gemini' },
    ],
    carte: 24,
    echeances: resultat.echeances,
    texte: `<<<QUESTION-abcd1234\n${hostile}\nQUESTION-abcd1234>>>`,
  };
  h.respond.set(
    'POST /api/avis-mesh',
    json(202, { ...demande, confirmation: 'confirmation-exemple', apercu }),
  );
  h.respond.set('GET /api/confirmations', json(200, { ouvertes: [], recentes: [] }));
  await userEvent.click(envoyer());
  const vue = await screen.findByRole('region', { name: 'Aperçu exact' });
  expect(vue.textContent).toContain('peer-local — chair — orchestrator');
  expect(vue.textContent).toContain('pair-baseline — baseline — claude');
  expect(vue.querySelector('pre')?.textContent).toBe(apercu.texte);
  await screen.findByText('En attente de confirmation sur le téléphone');
  expect(document.querySelector('img')).toBeNull();
});

for (const tour of ['positions', 'rebuttal', 'vote'])
  test(`bornes de la durée ${tour}`, async () => {
    await boite();
    await remplir();
    const duree = screen.getByLabelText(`Durée ${tour} (heures)`);
    for (const valeur of ['0', '169']) {
      fireEvent.change(duree, { target: { value: valeur } });
      expect(envoyer().disabled).toBe(true);
    }
    for (const valeur of ['1', '168']) {
      fireEvent.change(duree, { target: { value: valeur } });
      expect(envoyer().disabled).toBe(false);
    }
  });

for (const [phase, etatBaseline, passe, visible] of [
  ['positions', 'attendu', true, true],
  ['positions', 'attendu', false, false],
  ['rebuttal', 'attendu', true, false],
  ['positions', 'scelle', true, false],
  ['positions', 'declare_absent', true, false],
  ['positions', 'ok', true, false],
] as const)
  test(`bouton absence : ${phase}, ${etatBaseline}, échéance passée ${passe}`, async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(date) + (passe ? 1 : -1));
    const baseline = {
      ...resultat.avis[0]!,
      etat: etatBaseline,
      reason: hostile,
      by: 'peer-local',
      at: date,
    };
    const h = setup(<DemandesAvisMesh />, snapshot(), '/', {
      'GET /api/avis-mesh': json(200, { demandes: [demande] }),
      'GET /api/avis-mesh/demande%2F1': json(200, { ...resultat, phase, baseline }),
      'POST /api/avis-mesh/demande%2F1/baseline-absent': json(409, {
        error: 'le baseline a déjà posté',
      }),
    });
    await userEvent.click(await screen.findByRole('button', { name: /Carte 24 — Ouverte/ }));
    await screen.findByRole('table');
    const bouton = screen.queryByRole('button', { name: 'Déclarer le baseline absent' });
    expect(!!bouton).toBe(visible);
    if (bouton) {
      await userEvent.click(bouton);
      await screen.findByText('le baseline a déjà posté');
      expect(h.calls.find((c) => c.method === 'POST')?.body).toEqual({ mesh: 'principal' });
    }
  });

test('reprise : trois nouvelles durées, POST motion confirmé et aucun nouvel rooms open', async () => {
  const h = setup(<DemandesAvisMesh />, snapshot(), '/', {
    'GET /api/avis-mesh': json(200, { demandes: [{ ...demande, etat: 'salle-sans-motion' }] }),
    'POST /api/avis-mesh/demande%2F1/motion': json(202, { confirmation: 'confirmation-motion' }),
    'GET /api/confirmations': json(200, { ouvertes: [], recentes: [] }),
  });
  await userEvent.click(await screen.findByRole('button', { name: 'Rouvrir la motion' }));
  for (const tour of ['positions', 'rebuttal', 'vote'])
    expect(screen.getByLabelText(`Durée ${tour} (heures)`)).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Envoyer la motion' }));
  await screen.findByText('En attente de confirmation sur le téléphone');
  expect(h.calls.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual([
    '/api/avis-mesh/demande%2F1/motion',
  ]);
});

for (const action of ['mesh.avis', 'mesh.avis.motion', 'mesh.avis.baseline-absent'])
  test(`panneau : ${action}, erreur gateway exacte`, async () => {
    const { PanneauConfirmations } = await import('../../web/src/ui/PanneauConfirmations.js');
    setup(<PanneauConfirmations />, snapshot(), '/', {
      'GET /api/confirmations/reglage': json(200, { actions: [], arme: true }),
      'GET /api/confirmations': json(200, {
        ouvertes: [],
        recentes: [
          {
            id: 'confirmation-exemple',
            action,
            resume: action,
            classe: 'toujours',
            echeance: 0,
            etat: 'consommee',
            resultat: 'echouee',
            envoi: { code: 'upstream_error', status: 409, detail: hostile },
          },
        ],
      }),
    });
    await screen.findByText(new RegExp(`409 ${hostile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    expect(document.querySelector('img')).toBeNull();
  });

test('les deux reprises portent aussi X-AID-Confirm: avis et un id encodé', async () => {
  const { agirAvisMesh } = await import('../../web/src/data/avis-mesh.js');
  const fetchImpl = vi.fn(
    async () =>
      new Response(JSON.stringify({ confirmation: 'confirmation-exemple' }), { status: 202 }),
  );
  const client = new AidClient({ fetchImpl: fetchImpl as typeof fetch });
  for (const action of ['motion', 'baseline-absent'] as const)
    await agirAvisMesh('demande/1', action, client, resultat.echeances);
  for (const [, init] of fetchImpl.mock.calls as unknown as [string, RequestInit][])
    expect(init.headers).toMatchObject({ 'X-AID-Confirm': 'avis' });
});

test.each([
  ['avis', 'maintient'],
  ['abstention', 'abstention au vote'],
  ['objection', 'objection'],
  ['scelle', 'scellé par le gateway'],
  ['invalide', 'vote invalide'],
] as const)('vote %s affiché à côté de la position', (vote, libelle) => {
  render(<TableauAvisMesh resultat={{ ...resultat, avis: [{ ...resultat.avis[0]!, vote }] }} />);
  expect(screen.getByRole('columnheader', { name: new RegExp(`Vote : ${libelle}`) })).toBeTruthy();
  expect(screen.getByText('oui')).toBeTruthy();
});
