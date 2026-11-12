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
const demande = { id: 'demande/1', etat: 'attendu', date, cells: ['pair-1', 'pair-2'], carte: 24 };
const hostile = '<img src=x onerror=alert(1)> javascript:alert(1)';
const resultat: ResultatAvisMesh = {
  format: 'aid-avis-mesh/1',
  phase: 'vote',
  echeances: { positions: date, vote: date },
  sous_questions: [{ n: 1, texte: 'Question' }],
  avis: (
    ['ok', 'scelle', 'absent', 'attendu', 'abstention', 'secret_suspecte', 'invalide'] as const
  ).map((etat, i) => ({
    i,
    cell: `pair-${i + 1}`,
    etat,
    brut: etat === 'invalide' ? hostile : null,
    reponses: etat === 'ok' ? [{ n: 1, verdict: 'oui', justification: hostile }] : [],
    vote_pris_en_compte: false,
    vote_scelle: etat === 'ok',
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
  for (let i = 2; i <= 8; i++) await userEvent.click(screen.getByLabelText(`pair-${i}`));
  expect((screen.getByLabelText('pair-9') as HTMLInputElement).disabled).toBe(true);
  expect(envoyer().disabled).toBe(false);
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
test('échéances par défaut et bornes, tours optionnels puis corps exact', async () => {
  const h = await boite();
  await remplir();
  const positions = screen.getByLabelText('Durée positions (heures)');
  expect((positions as HTMLInputElement).value).toBe('24');
  for (const valeur of ['0', '169']) {
    fireEvent.change(positions, { target: { value: valeur } });
    expect(envoyer().disabled).toBe(true);
  }
  fireEvent.change(positions, { target: { value: '1' } });
  await userEvent.click(screen.getByLabelText('Activer rebuttal'));
  await userEvent.click(screen.getByLabelText('Activer vote'));
  fireEvent.change(screen.getByLabelText('Durée vote (heures)'), { target: { value: '168' } });
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(date));
  await userEvent.click(envoyer());
  await screen.findByText('Demande demande/1 — attendu');
  expect(h.calls.find((c) => c.method === 'POST')?.body).toEqual({
    question: 'Question',
    cells: ['pair-1', 'pair-2'],
    carte: 24,
    echeances: {
      positions: '2026-11-12T13:00:00.000Z',
      rebuttal: '2026-11-13T13:00:00.000Z',
      vote: '2026-11-20T13:00:00.000Z',
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
    echeances: { positions: date },
  };
  await demanderAvisMesh(corps, client);
  const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('/api/avis-mesh');
  expect(init.method).toBe('POST');
  expect(init.headers).toMatchObject({ 'X-AID-Confirm': 'avis' });
  expect(JSON.parse(String(init.body))).toEqual(corps);
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
  expect(screen.getAllByText(date)).toHaveLength(2);
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
  const bouton = await screen.findByRole('button', { name: /pair-1, pair-2 — Carte 24 — attendu/ });
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

test('envoi par défaut : positions à 24 h, sans rebuttal ni vote', async () => {
  const h = await boite();
  await remplir();
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(date));
  await userEvent.click(envoyer());
  await screen.findByText('Demande demande/1 — attendu');
  expect(h.calls.find((c) => c.method === 'POST')?.body).toEqual({
    question: 'Question',
    cells: ['pair-1', 'pair-2'],
    carte: 24,
    echeances: { positions: '2026-11-13T12:00:00.000Z' },
  });
});
