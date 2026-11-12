// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { Route, Routes, useNavigate } from 'react-router';
import type { MeshDm, MeshState } from '../../src/shared/model.js';
import type { BoardCardSheet, BoardResult } from '../../src/shared/board.js';
import { parseCard } from '../../src/shared/board.js';
import { useBoardCard, useBoardProjects } from '../../web/src/data/board.js';
import {
  useCells,
  useFederation,
  useMemoire,
  usePageMemoire,
  useReglages,
} from '../../web/src/data/swarph.js';
import { useMeshLecture } from '../../web/src/data/meshLecture.js';
import type { MeshWeb } from '../../web/src/data/meshes.js';
import { Boite } from '../../web/src/ecrans/Boite.js';
import { Board } from '../../web/src/ecrans/Board.js';
import { CarteBoard } from '../../web/src/ecrans/CarteBoard.js';
import { Layout } from '../../web/src/ui/Layout.js';
import { EcranMesh } from '../../web/src/ui/SelecteurMesh.js';
import { PastillesMeshes } from '../../web/src/ui/PastillesMeshes.js';
import { EcrireAuMesh } from '../../web/src/ui/EcrireAuMesh.js';
import { FormulaireAvisMesh } from '../../web/src/ui/FormulaireAvisMesh.js';
import { DemandesAvisMesh } from '../../web/src/ui/DemandesAvisMesh.js';
import { PropositionAidVue } from '../../web/src/ui/PropositionsAid.js';
import { PropositionSwairmVue } from '../../web/src/ui/PropositionsSwairm.js';
import { cleDm, dmsFusionnes } from '../../web/src/ui/boiteVue.js';
import { FakeSocket, json, setup, snapshot, type Harness } from './helpers.js';

const date = '2026-11-12T12:00:00.000Z';
const monitor: MeshState = {
  cell: 'peer-a',
  connected: true,
  ecritures: true,
  proxyConfigure: true,
  superviseur: null,
  monitor: 'running',
  tailscale: 'running',
  pending: 0,
  since: null,
};
const boite = (inbox: MeshDm[] = []) => ({ state: monitor, inbox, tailscaleManage: false });
const dm = (content: string, createdAt: string): MeshDm => ({
  id: 1,
  from: 'peer-b',
  to: 'peer-a',
  kind: 'question',
  content,
  createdAt,
  threadId: null,
  replyTo: null,
  obligationId: null,
  seenAt: null,
  decidedAt: null,
});
const entree = (nom: string, champs: Partial<MeshWeb> = {}): MeshWeb => ({
  nom,
  cell: 'peer-a',
  actif: true,
  erreur: null,
  etat: monitor,
  ecriture: true,
  ...champs,
});
const meshes = [entree('principal'), entree('perso')];
const etat = () => snapshot({ mesh: boite(), meshes: { principal: boite(), perso: boite() } });
const routes = {
  'GET /api/meshes': json(200, meshes),
  'GET /api/nav': json(200, { groups: [], placements: [], prefs: { reduit: false } }),
  'GET /api/aid/propositions': json(200, []),
  'GET /api/swairm/propositions': json(200, []),
};
const apercu = {
  ok: true,
  aBlanc: true,
  resume: 'Résumé exact',
  argv: [],
  texte: 'Texte exact',
  rappel: null,
};
const ok = <T,>(data: T): BoardResult<T> => ({ ok: true, data, readAt: date, schemaVersion: null });
const fiche: BoardCardSheet = {
  card: ok(
    parseCard({ id: 12, project_id: 1, title: 'Carte perso', author: 'peer-b', body: 'Corps' })!
      .value,
  ),
  graph: ok({ steps: [], missing: [], unconfirmed: [], stageImplied: null }),
  obligations: ok({ obligations: [], truncated: false, asOf: null }),
  thread: { ok: false, kind: 'unknown', readAt: date },
};
async function joindre() {
  await waitFor(() => expect(FakeSocket.all.length).toBeGreaterThan(0));
  act(() => FakeSocket.all[0]!.open());
}
function posts(h: Harness) {
  return h.calls.filter((c) => c.method === 'POST');
}
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

test('un seul mesh actif : aucun sélecteur, filtre, bandeau ou pastille nouveau', async () => {
  setup(<Boite />, etat(), '/boite', {
    ...routes,
    'GET /api/meshes': json(200, [
      entree('principal'),
      entree('perso', { actif: false, erreur: 'binaire' }),
    ]),
  });
  await joindre();
  await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  expect(screen.queryByLabelText('Mesh')).toBeNull();
  expect(screen.queryByText('Filtrer par mesh')).toBeNull();
  expect(screen.queryByLabelText('État des meshes')).toBeNull();
});

test('fusion chronologique et clés distinctes pour deux DM de même id, sans dupliquer l’alias', () => {
  const principal = boite([dm('Ancien', '2026-11-12T10:00:00Z')]);
  const perso = boite([dm('Récent', '2026-11-12T11:00:00Z')]);
  const fusion = dmsFusionnes(snapshot({ mesh: principal, meshes: { perso, principal } }));
  expect(fusion.map((d) => [d.mesh, d.content])).toEqual([
    ['principal', 'Ancien'],
    ['perso', 'Récent'],
  ]);
  expect(new Set(fusion.map(cleDm)).size).toBe(2);
});

test('boîte : pastilles, filtre replié, vu/décidé et réponse sur le mesh du DM', async () => {
  const s = etat();
  s.meshes!.principal = boite([dm('Message principal', '2026-11-12T10:00:00Z')]);
  s.meshes!.perso = boite([dm('Message perso', '2026-11-12T11:00:00Z')]);
  s.mesh = s.meshes!.principal;
  const h = setup(<Boite />, s, '/boite', {
    ...routes,
    'POST /api/swarph/ecrire/apercu': json(200, apercu),
    'POST /api/swarph/ecrire/envoyer': json(200, { code: 'succes', open_obligations: [] }),
  });
  await joindre();
  await screen.findByLabelText('État des meshes');
  const articles = [...document.querySelectorAll('article')].filter((a) =>
    a.textContent?.includes('Message '),
  );
  expect(articles.map((a) => a.querySelector('pre')?.textContent)).toEqual([
    'Message perso',
    'Message principal',
  ]);
  expect(articles[0]!.querySelector('.badge')?.textContent).toBeTruthy();
  expect(screen.getByText('Filtrer par mesh').parentElement).toHaveProperty('open', false);
  fireEvent.change(screen.getByLabelText('Filtrer par mesh'), { target: { value: 'perso' } });
  expect(screen.queryByText('Message principal')).toBeNull();
  const article = screen.getByText('Message perso').closest('article')!;
  expect(within(article).getByText('perso').className).toBe('badge');
  fireEvent.click(within(article).getByText('En faire une décision'));
  await waitFor(() =>
    expect(posts(h).some((c) => c.url === '/api/mesh/perso/dm/1/decision')).toBe(true),
  );
  fireEvent.click(within(article).getByText('Vu'));
  await waitFor(() =>
    expect(posts(h).some((c) => c.url === '/api/mesh/perso/dm/1/seen')).toBe(true),
  );
  fireEvent.click(within(article).getByText('Répondre (à blanc)'));
  fireEvent.change(screen.getByLabelText('Texte'), { target: { value: 'Réponse' } });
  fireEvent.click(screen.getByText("Voir l'aperçu"));
  const section = await screen.findByRole('region', { name: 'Aperçu' });
  expect(section.firstElementChild?.textContent).toBe('Mesh : perso');
  fireEvent.click(within(section).getByText('Envoyer'));
  await waitFor(() =>
    expect(posts(h).find((c) => c.url.endsWith('/envoyer'))?.body).toMatchObject({
      mesh: 'perso',
      params: { pair: 'peer-b', texte: 'Réponse' },
    }),
  );
});

function Lectures() {
  const mesh = useMeshLecture();
  useBoardProjects();
  useBoardCard(12);
  useCells();
  useReglages();
  useFederation('exemple');
  useMemoire('exemple');
  usePageMemoire('exemple');
  return <p>Lecture : {mesh}</p>;
}
test('sélecteur : stockage par écran, valeurs inconnues, inactifs et lectures cloisonnées', async () => {
  localStorage.setItem('aid.mesh.cells', 'inconnu');
  const h = setup(
    <EcranMesh ecran="cells">
      <Lectures />
    </EcranMesh>,
    etat(),
    '/',
    {
      ...routes,
      'GET /api/meshes': json(200, [
        ...meshes,
        entree('archive', { actif: false, erreur: 'binaire' }),
      ]),
    },
  );
  await joindre();
  const select = await screen.findByLabelText('Mesh');
  expect(select).toHaveProperty('value', 'principal');
  expect(screen.getByRole('option', { name: 'archive — binaire' })).toHaveProperty(
    'disabled',
    true,
  );
  fireEvent.change(select, { target: { value: 'archive' } });
  expect(select).toHaveProperty('value', 'principal');
  fireEvent.change(select, { target: { value: 'perso' } });
  await screen.findByText('Lecture : perso');
  expect(localStorage.getItem('aid.mesh.cells')).toBe('perso');
  const chemins = [
    '/api/board/projects',
    '/api/board/cards/12',
    '/api/swarph/cells',
    '/api/swarph/reglages',
    '/api/swarph/federation?q=exemple',
    '/api/swarph/memory?tag=exemple',
    '/api/swarph/memory/page?slug=exemple',
  ];
  for (const chemin of chemins)
    expect(
      h.calls.some((c) => c.url === `${chemin}${chemin.includes('?') ? '&' : '?'}mesh=perso`),
    ).toBe(true);
  cleanup();
  setup(
    <EcranMesh ecran="cells">
      <p>Cells</p>
    </EcranMesh>,
    etat(),
    '/',
    routes,
  );
  await joindre();
  expect(await screen.findByLabelText('Mesh')).toHaveProperty('value', 'perso');
  cleanup();
  setup(
    <EcranMesh ecran="board">
      <p>Board</p>
    </EcranMesh>,
    etat(),
    '/',
    routes,
  );
  await joindre();
  expect(await screen.findByLabelText('Mesh')).toHaveProperty('value', 'principal');
});

test('stockage local refusé en lecture et écriture : la page reste utilisable', async () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('refus');
  });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('refus');
  });
  setup(
    <EcranMesh ecran="cells">
      <Lectures />
    </EcranMesh>,
    etat(),
    '/',
    routes,
  );
  await joindre();
  fireEvent.change(await screen.findByLabelText('Mesh'), { target: { value: 'perso' } });
  await screen.findByText('Lecture : perso');
});

test('archivage : confirmation explicite, annulation, POST puis actualisation', async () => {
  const h = setup(
    <EcranMesh ecran="board">
      <p>Board</p>
    </EcranMesh>,
    etat(),
    '/',
    {
      ...routes,
      'GET /api/meshes': json(200, [
        ...meshes,
        entree('archive', { actif: false, erreur: 'rebranche' }),
      ]),
      'POST /api/meshes/archive/archiver': json(200, { ok: true }),
      'GET /api/meshes?fresh=1': json(200, meshes),
    },
  );
  await joindre();
  const bouton = await screen.findByText('Archiver les anciennes données — archive');
  fireEvent.click(bouton);
  expect(posts(h)).toHaveLength(0);
  fireEvent.click(screen.getByText('Annuler'));
  expect(screen.queryByRole('alertdialog')).toBeNull();
  fireEvent.click(bouton);
  fireEvent.click(screen.getByText('Confirmer l’archivage'));
  await waitFor(() => expect(posts(h).map((c) => c.url)).toEqual(['/api/meshes/archive/archiver']));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  expect(h.calls.some((c) => c.url === '/api/meshes?fresh=1')).toBe(true);
});

test('formulaire : bandeau en tête et aucun texte, fil ou cible transmis au changement de mesh', async () => {
  const h = setup(
    <EcrireAuMesh
      mesh="principal"
      action="dm.envoyer"
      valeurs={{ pair: 'peer-b', texte: 'Texte principal', fil: 'fil-principal' }}
      onClose={() => {}}
    />,
    etat(),
    '/',
    { ...routes, 'POST /api/swarph/ecrire/apercu': json(200, apercu) },
  );
  await joindre();
  // Le même composant change de mesh sans que ses anciennes valeurs soient recopiées.
  const { AidProvider } = await import('../../web/src/data/useAidState.js');
  const { MemoryRouter } = await import('react-router');
  const { render } = await import('@testing-library/react');
  cleanup();
  const vue = render(
    <MemoryRouter>
      <AidProvider client={h.client}>
        <EcrireAuMesh
          mesh="principal"
          action="dm.envoyer"
          valeurs={{ pair: 'peer-b', texte: 'Texte principal', fil: 'fil-principal' }}
          onClose={() => {}}
        />
      </AidProvider>
    </MemoryRouter>,
  );
  vue.rerender(
    <MemoryRouter>
      <AidProvider client={h.client}>
        <EcrireAuMesh
          mesh="perso"
          action="dm.envoyer"
          valeurs={{ pair: 'peer-b', texte: 'Texte principal', fil: 'fil-principal' }}
          onClose={() => {}}
        />
      </AidProvider>
    </MemoryRouter>,
  );
  expect(screen.getByLabelText('Texte')).toHaveProperty('value', '');
  expect(screen.getByLabelText('Pair')).toHaveProperty('value', '');
  fireEvent.change(screen.getByLabelText('Texte'), { target: { value: 'Texte perso' } });
  fireEvent.change(screen.getByLabelText('Pair'), { target: { value: 'peer-a' } });
  fireEvent.click(screen.getByText("Voir l'aperçu"));
  const section = await screen.findByRole('region', { name: 'Aperçu' });
  expect(section.firstElementChild?.textContent).toBe('Mesh : perso');
  expect(posts(h).at(-1)?.body).toMatchObject({
    mesh: 'perso',
    params: { pair: 'peer-a', fil: null, texte: 'Texte perso' },
  });
});

test.each([1, 3, 4])(
  'barre : %i mesh actif, au plus trois pastilles et le compte restant',
  async (n) => {
    const liste = ['principal', 'perso', 'exemple-a', 'exemple-b']
      .slice(0, n)
      .map((nom) => entree(nom));
    setup(<PastillesMeshes />, etat(), '/', { 'GET /api/meshes': json(200, liste) });
    await joindre();
    if (n === 1) {
      await act(async () => {});
      expect(screen.queryByLabelText('État des meshes')).toBeNull();
    } else {
      const barre = await screen.findByLabelText('État des meshes');
      expect(barre.querySelectorAll('.badge')).toHaveLength(Math.min(n, 3));
      expect(barre.textContent?.includes('+1')).toBe(n === 4);
    }
  },
);

test('propositions : le mesh renvoyé par le daemon est celui des deux écritures', async () => {
  const p = { id: 1, mesh: 'perso', sujet: 's', carte: 12, etape: 'review' as const };
  const h = setup(
    <>
      <PropositionAidVue proposition={p} relire={() => {}} />
      <PropositionSwairmVue
        proposition={{
          id: 2,
          mesh: 'perso',
          projet: 'exemple',
          sujet: 's',
          carte: 12,
          titre: 'Note perso',
          etat: 'merged',
        }}
        relire={() => {}}
      />
    </>,
    etat(),
    '/',
    {
      ...routes,
      'GET /api/aid/propositions/1/apercu': json(200, {
        mesh: 'perso',
        params: { carte: 12 },
        resume: 'Déplacement perso',
      }),
      'POST /api/swarph/etat/envoyer': json(202, { confirmation: 'deplacement' }),
      'POST /api/swarph/ecrire/apercu': json(200, apercu),
      'POST /api/swarph/ecrire/envoyer': json(202, { confirmation: 'note' }),
    },
  );
  await joindre();
  fireEvent.click(screen.getAllByText('Ouvrir')[0]!);
  await screen.findByText('Déplacement perso');
  fireEvent.click(screen.getByText('Envoyer'));
  await waitFor(() =>
    expect(posts(h)[0]?.body).toMatchObject({ mesh: 'perso', propositionAid: 1 }),
  );
  fireEvent.click(screen.getByText('Fermer'));
  fireEvent.click(screen.getAllByText('Ouvrir')[1]!);
  fireEvent.click(screen.getByText("Voir l'aperçu"));
  await screen.findByText('Résumé exact');
  fireEvent.click(screen.getByText('Envoyer'));
  await waitFor(() =>
    expect(posts(h).find((c) => c.url === '/api/swarph/ecrire/envoyer')?.body).toMatchObject({
      mesh: 'perso',
      propositionSwairm: 2,
    }),
  );
});

test('board perso : la carte conserve son mesh et sa note vise perso ; le sélecteur vide la cible', async () => {
  const h = setup(
    <Routes>
      <Route path="/board" element={<Board />} />
      <Route path="/board/cartes/:cardId" element={<CarteBoard />} />
    </Routes>,
    etat(),
    '/board',
    {
      ...routes,
      'GET /api/board/projects': json(200, ok([])),
      'GET /api/board/projects?mesh=perso': json(
        200,
        ok([{ id: 1, slug: 'exemple', title: 'Projet perso', status: 'active', author: 'peer-a' }]),
      ),
      'GET /api/board/projects/1/cards?mesh=perso': json(
        200,
        ok([
          {
            id: 12,
            projectId: 1,
            title: 'Carte perso',
            stage: 'idea',
            assignee: null,
            dueAt: null,
            openObligations: 0,
          },
        ]),
      ),
      'GET /api/board/cards/12?mesh=perso': json(200, fiche),
      'POST /api/swarph/ecrire/apercu': json(200, apercu),
      'POST /api/swarph/ecrire/envoyer': json(202, { confirmation: 'note' }),
    },
  );
  await joindre();
  fireEvent.change(await screen.findByLabelText('Mesh'), { target: { value: 'perso' } });
  const lien = await screen.findByRole('link', { name: /Carte perso/ });
  expect(lien.getAttribute('href')).toBe('/board/cartes/12?mesh=perso');
  fireEvent.click(lien);
  fireEvent.click(await screen.findByText('Écrire une note (à blanc)'));
  fireEvent.change(screen.getByLabelText('Texte'), { target: { value: 'Note perso' } });
  fireEvent.click(screen.getByText("Voir l'aperçu"));
  await screen.findByText('Résumé exact');
  fireEvent.click(screen.getByText('Envoyer'));
  await waitFor(() =>
    expect(posts(h).find((c) => c.url.endsWith('/envoyer'))?.body).toMatchObject({
      mesh: 'perso',
      params: { carte: 12 },
    }),
  );
  fireEvent.click(screen.getByText('Fermer'));
  fireEvent.change(screen.getByLabelText('Mesh'), { target: { value: 'principal' } });
  await waitFor(() => expect(screen.queryByText('Écrire une note (à blanc)')).toBeNull());
  expect(h.calls.some((c) => c.url === '/api/board/cards/12')).toBe(false);
});

test('avis perso : configuration, pairs, carte et salle sont lus sur leur mesh ; la motion y est envoyée', async () => {
  const demande = {
    id: 'salle',
    etat: 'salle-sans-motion',
    date,
    cells: ['peer-a', 'peer-b'],
    carte: 12,
  };
  const h = setup(
    <>
      <FormulaireAvisMesh mesh="perso" />
      <DemandesAvisMesh mesh="perso" />
    </>,
    etat(),
    '/',
    {
      ...routes,
      'GET /api/avis-mesh/config?mesh=perso': json(200, {
        cellAid: 'peer-a',
        baseline: 'peer-b',
        familles: {},
      }),
      'GET /api/swarph/cells?mesh=perso': json(200, { peers: ok([]), monitor }),
      'GET /api/avis-mesh?mesh=perso': json(200, { demandes: [demande] }),
      'GET /api/board/cards/12?mesh=perso': json(200, fiche),
      'POST /api/avis-mesh/salle/motion': json(202, { confirmation: 'motion' }),
    },
  );
  await joindre();
  fireEvent.change(await screen.findByLabelText('Numéro de carte'), { target: { value: '12' } });
  await screen.findByText('Carte perso');
  fireEvent.click(await screen.findByText('Rouvrir la motion'));
  fireEvent.click(screen.getByText('Envoyer la motion'));
  await waitFor(() =>
    expect(posts(h).find((c) => c.url.endsWith('/motion'))?.body).toMatchObject({ mesh: 'perso' }),
  );
  expect(
    h.calls
      .filter((c) => c.url.startsWith('/api/avis-mesh') && c.method === 'GET')
      .every((c) => c.url.includes('mesh=perso')),
  ).toBe(true);
  expect(h.calls.some((c) => c.url === '/api/swarph/cells?mesh=perso')).toBe(true);
});

test('un seul mesh perso : lecture utilisable sans principal ni nouveau sélecteur', async () => {
  const h = setup(
    <EcranMesh ecran="cells">
      <Lectures />
    </EcranMesh>,
    snapshot({ meshes: { perso: boite() } }),
    '/',
    { 'GET /api/meshes': json(200, [entree('perso')]) },
  );
  await joindre();
  await screen.findByText('Lecture : perso');
  expect(screen.queryByLabelText('Mesh')).toBeNull();
  expect(h.calls.some((c) => c.url === '/api/swarph/cells?mesh=perso')).toBe(true);
});

test('lien direct perso : aucun appel à la carte homonyme de principal pendant le chargement des meshes', async () => {
  let recevoir!: (r: Response) => void;
  const reponse = new Promise<Response>((resolve) => {
    recevoir = resolve;
  });
  const h = setup(
    <Routes>
      <Route path="/board/cartes/:cardId" element={<CarteBoard />} />
    </Routes>,
    etat(),
    '/board/cartes/12?mesh=perso',
    {
      ...routes,
      'GET /api/meshes': (() => reponse) as unknown as () => Response,
      'GET /api/board/cards/12?mesh=perso': json(200, fiche),
    },
  );
  await joindre();
  expect(h.calls.some((c) => c.url.startsWith('/api/board/cards/'))).toBe(false);
  await act(async () => {
    recevoir(json(200, meshes)());
  });
  await screen.findByText('Carte perso');
  expect(h.calls.some((c) => c.url === '/api/board/cards/12')).toBe(false);
});

test('nouvelle salle perso : seules ses cells et sa carte alimentent l’écriture et son aperçu', async () => {
  const h = setup(<FormulaireAvisMesh mesh="perso" />, etat(), '/', {
    ...routes,
    'GET /api/avis-mesh/config?mesh=perso': json(200, {
      cellAid: 'peer-a',
      baseline: 'peer-b',
      familles: { 'peer-a': 'chair', 'peer-b': 'claude', 'peer-c': 'gpt', 'peer-d': 'gemini' },
    }),
    'GET /api/swarph/cells?mesh=perso': json(200, {
      peers: ok(['peer-a', 'peer-b', 'peer-c', 'peer-d'].map((nom) => ({ nom }))),
      monitor,
    }),
    'GET /api/board/cards/12?mesh=perso': json(200, fiche),
    'POST /api/avis-mesh': json(200, {
      id: 'salle',
      etat: 'ouverte',
      date,
      cells: ['peer-c', 'peer-d'],
      carte: 12,
      apercu: { nom: 'Avis perso', sieges: [], carte: 12, echeances: {}, texte: 'Question perso' },
    }),
  });
  await joindre();
  fireEvent.click(await screen.findByLabelText('peer-c'));
  fireEvent.click(screen.getByLabelText('peer-d'));
  expect(screen.queryByLabelText('peer-a')).toBeNull();
  expect(screen.queryByLabelText('peer-b')).toBeNull();
  fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'Question perso' } });
  fireEvent.change(screen.getByLabelText('Numéro de carte'), { target: { value: '12' } });
  fireEvent.click(await screen.findByText('Confirmer la carte'));
  expect(screen.getByText('Envoyer')).toHaveProperty('disabled', false);
  fireEvent.click(screen.getByText('Envoyer'));
  await waitFor(() =>
    expect(posts(h)[0]?.body).toMatchObject({
      mesh: 'perso',
      carte: 12,
      cells: ['peer-c', 'peer-d'],
      question: 'Question perso',
    }),
  );
  const section = await screen.findByRole('region', { name: 'Aperçu exact' });
  expect(section.firstElementChild?.textContent).toBe('Mesh : perso');
});

test('obligation perso : l’autorisation et l’écriture viennent du mesh de la carte', async () => {
  const { ChangerEtat } = await import('../../web/src/ui/ChangerEtat.js');
  const s = etat();
  s.mesh = boite();
  s.mesh.state = { ...monitor, ecritures: false };
  s.meshes!.principal = s.mesh;
  const h = setup(
    <ChangerEtat
      mesh="perso"
      carte={12}
      obligation={{
        id: 1,
        holder: 'peer-a',
        status: 'open',
        step: 'build',
        state: null,
        takenAt: null,
        unclosableReason: null,
        accept: 'Critère',
        conditions: [],
        closed: false,
        closedAt: null,
        closeOutcome: null,
        closeEvidence: null,
        fallbackPolicy: null,
        needsExtra: null,
      }}
      etape={undefined}
      relire={() => {}}
    />,
    s,
    '/',
    { ...routes, 'POST /api/swarph/etat/envoyer': json(202, { confirmation: 'obligation' }) },
  );
  await joindre();
  fireEvent.click(await screen.findByText('Prendre'));
  const dialogue = screen.getByRole('dialog');
  expect(await within(dialogue).findByText('Mesh : perso')).toBeTruthy();
  fireEvent.click(screen.getByText('Confirmer'));
  await waitFor(() =>
    expect(posts(h)[0]?.body).toMatchObject({
      mesh: 'perso',
      action: 'obligation.prendre',
      params: { carte: 12, obligation: 1 },
    }),
  );
});

test('archivage : aucune carte de l’ancienne identité ne réapparaît depuis le cache', async () => {
  function CarteLue() {
    const lecture = useBoardCard(12);
    const pairs = useCells();
    return (
      <div>
        <span>{pairs.result?.peers.ok ? pairs.result.peers.data[0]?.nom : ''}</span>
        <p>{lecture.result?.card.ok ? lecture.result.card.data.title : 'Lecture en cours'}</p>
      </div>
    );
  }
  let liste = [...meshes, entree('exemple')];
  let archive = false;
  let recevoir!: (r: Response) => void;
  let recevoirPairs!: (r: Response) => void;
  const nouveauxPairs = new Promise<Response>((resolve) => {
    recevoirPairs = resolve;
  });
  const nouvelle = new Promise<Response>((resolve) => {
    recevoir = resolve;
  });
  const h = setup(
    <EcranMesh ecran="board">
      <CarteLue />
    </EcranMesh>,
    etat(),
    '/',
    {
      'GET /api/meshes': () => json(200, liste)(),
      'GET /api/meshes?fresh=1': () => json(200, [...meshes, entree('exemple')])(),
      'GET /api/board/cards/12': json(200, fiche),
      'GET /api/swarph/cells': json(200, { peers: ok([]), monitor }),
      'GET /api/swarph/cells?mesh=perso': (() =>
        archive
          ? nouveauxPairs
          : json(200, {
              peers: ok([{ nom: 'peer-ancien' }]),
              monitor,
            })()) as unknown as () => Response,
      'GET /api/board/cards/12?mesh=perso': (() =>
        archive
          ? nouvelle
          : json(200, {
              ...fiche,
              card: ok({ ...(fiche.card.ok && fiche.card.data), title: 'Ancienne carte perso' }),
            })()) as unknown as () => Response,
      'POST /api/meshes/perso/archiver': () => {
        archive = true;
        return json(200, { ok: true })();
      },
    },
  );
  await joindre();
  fireEvent.change(await screen.findByLabelText('Mesh'), { target: { value: 'perso' } });
  await screen.findByText('Ancienne carte perso');
  await screen.findByText('peer-ancien');
  fireEvent.change(screen.getByLabelText('Mesh'), { target: { value: 'principal' } });
  liste = [
    entree('principal'),
    entree('perso', { actif: false, erreur: 'rebranche' }),
    entree('exemple'),
  ];
  act(() => window.dispatchEvent(new Event('focus')));
  fireEvent.click(await screen.findByText('Archiver les anciennes données — perso'));
  fireEvent.click(screen.getByText('Confirmer l’archivage'));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  fireEvent.change(screen.getByLabelText('Mesh'), { target: { value: 'perso' } });
  expect(screen.queryByText('Ancienne carte perso')).toBeNull();
  expect(screen.queryByText('peer-ancien')).toBeNull();
  await act(async () => {
    recevoir(json(200, fiche)());
    recevoirPairs(json(200, { peers: ok([{ nom: 'peer-b' }]), monitor })());
  });
  await screen.findByText('Carte perso');
  expect(h.calls.filter((c) => c.url === '/api/board/cards/12?mesh=perso').length).toBeGreaterThan(
    1,
  );
});

test('archiver un mesh mémorisé mais inactif ne le sélectionne pas automatiquement', async () => {
  localStorage.setItem('aid.mesh.board', 'perso');
  setup(
    <EcranMesh ecran="board">
      <p>Board</p>
    </EcranMesh>,
    etat(),
    '/',
    {
      'GET /api/meshes': json(200, [
        entree('principal'),
        entree('perso', { actif: false, erreur: 'rebranche' }),
        entree('exemple'),
      ]),
      'GET /api/meshes?fresh=1': json(200, [...meshes, entree('exemple')]),
      'POST /api/meshes/perso/archiver': json(200, { ok: true }),
    },
  );
  await joindre();
  expect(await screen.findByLabelText('Mesh')).toHaveProperty('value', 'principal');
  fireEvent.click(screen.getByText('Archiver les anciennes données — perso'));
  fireEvent.click(screen.getByText('Confirmer l’archivage'));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  expect(screen.getByLabelText('Mesh')).toHaveProperty('value', 'principal');
});

test('le mesh survit aux paramètres de recherche du même écran, même sans stockage local', async () => {
  function PageRecherche() {
    const naviguer = useNavigate();
    return (
      <Layout screen="board">
        <button onClick={() => naviguer('/board?projet=2')}>Changer le projet</button>
        <button onClick={() => naviguer('/board?mesh=principal')}>Lien principal</button>
        <button onClick={() => naviguer('/board?mesh=perso')}>Lien perso</button>
        <Lectures />
      </Layout>
    );
  }
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('refus');
  });
  setup(
    <Routes>
      <Route path="/board" element={<PageRecherche />} />
    </Routes>,
    etat(),
    '/board?mesh=perso',
    routes,
  );
  await joindre();
  await screen.findByText('Lecture : perso');
  fireEvent.click(screen.getByText('Changer le projet'));
  expect(screen.getByText('Lecture : perso')).toBeTruthy();
  fireEvent.click(screen.getByText('Lien principal'));
  await screen.findByText('Lecture : principal');
  fireEvent.click(screen.getByText('Lien perso'));
  await screen.findByText('Lecture : perso');
});
