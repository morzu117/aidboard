// @vitest-environment jsdom
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router';
import { afterEach, expect, test } from 'vitest';
import { Accueil } from '../../web/src/ecrans/Accueil.js';
import { NouveauSujet } from '../../web/src/ecrans/NouveauSujet.js';
import { FakeSocket, json, setup, snapshot, ws } from './helpers.js';

// Chantier 28 (D141, D142) : Nouveau sujet est un écran. Ces tests reprennent ceux du dialogue supprimé
// (test/web/dialogues.test.tsx), et ajoutent l'URL, Annuler, la base et l'encart local.

afterEach(cleanup);
const node = (id: string) => document.querySelector(`[data-node="${id}"]`) as HTMLElement | null;
const text = (id: string) => node(id)?.textContent;

function Lieu() {
  const l = useLocation();
  return <p data-testid="lieu">{`${l.pathname}${l.search}`}</p>;
}
const app = (
  <>
    <Routes>
      <Route path="/" element={<Accueil />} />
      <Route path="/sujets/nouveau" element={<NouveauSujet />} />
      <Route path="/sujets/:topicId" element={<p>page du sujet</p>} />
    </Routes>
    <Lieu />
  </>
);
const lieu = () => screen.getByTestId('lieu').textContent;
const deux = () =>
  snapshot({
    workspaces: [
      ws({ id: 'ws_a', name: 'ancien', createdAt: '2026-01-01T00:00:00Z', baseBranch: 'develop' }),
      ws({ id: 'ws_z', name: 'récent', createdAt: '2026-10-01T00:00:00Z' }),
    ],
  });
const projet = () => (screen.getByLabelText('Projet') as HTMLSelectElement).value;
const creer = () => node('nouveau-sujet.pied.creer') as HTMLButtonElement;

async function pushEvent() {
  await act(async () => {
    FakeSocket.all[0]!.open();
    FakeSocket.all[0]!.push({
      kind: 'event',
      event: { id: `E${Math.random()}`, type: 'cost', data: {} },
    });
    await new Promise((r) => setTimeout(r, 40));
  });
}

test('D141 : « Nouveau sujet » mène à l’écran ; Annuler revient en arrière', async () => {
  setup(app, deux());
  await userEvent.click((await screen.findAllByRole('button', { name: 'Nouveau sujet' }))[0]!);
  expect(lieu()).toBe('/sujets/nouveau');
  expect(text('nouveau-sujet.titre')).toBe('Nouveau sujet');
  expect(screen.queryByRole('dialog')).toBeNull();
  await userEvent.click(node('nouveau-sujet.pied.annuler')!);
  expect(lieu()).toBe('/');
});

test('D141 : arrivé directement sur l’URL, Annuler va à l’accueil', async () => {
  setup(app, deux(), '/sujets/nouveau?projet=ws_a');
  await waitFor(() => expect(projet()).toBe('ws_a'));
  await userEvent.click(node('nouveau-sujet.pied.annuler')!);
  expect(lieu()).toBe('/');
});

test('D142 : branche suivant le titre et le type, base du projet, encart local, pied', async () => {
  setup(app, deux(), '/sujets/nouveau');
  await waitFor(() => expect(projet()).toBe('ws_z'));
  expect(text('nouveau-sujet.besoin.branche')).toBe('Branche : feat/(titre à saisir)');
  expect(text('nouveau-sujet.besoin.base')).toBe('Base : main');
  expect(creer().disabled).toBe(true);
  await userEvent.type(screen.getByLabelText('Titre'), "Écran d'accueil v2 !");
  expect(text('nouveau-sujet.besoin.branche')).toBe('Branche : feat/ecran-d-accueil-v2');
  await userEvent.selectOptions(screen.getByLabelText('Type'), 'fix');
  expect(text('nouveau-sujet.besoin.branche')).toBe('Branche : fix/ecran-d-accueil-v2');
  // le projet change la base, et l'URL
  await userEvent.selectOptions(screen.getByLabelText('Projet'), 'ws_a');
  expect(text('nouveau-sujet.besoin.base')).toBe('Base : develop');
  expect(lieu()).toBe('/sujets/nouveau?projet=ws_a');
  expect(text('nouveau-sujet.besoin.local')).toBe(
    '○ localCe sujet reste sur cette machine. Aucune autre machine ne le retrouvera tant que tu ne l’auras pas publié.',
  );
  expect(text('nouveau-sujet.pied.effet')).toBe(
    'À la création : rien n’est publié. Tu pourras publier plus tard.',
  );
  // le titre n'est jamais interprété
  expect(node('nouveau-sujet.besoin')?.querySelector('b')).toBeNull();
});

test('créer un sujet : navigation immédiate vers le brouillon (D15), sans attendre le script', async () => {
  const h = setup(app, deux(), '/sujets/nouveau');
  h.respond.set(
    'POST /api/topics',
    json(202, { actionId: 'ac_1', slug: 'abc', branch: 'feat/abc', topicId: 'tp_9' }),
  );
  await waitFor(() => expect(projet()).toBe('ws_z'));
  await userEvent.type(screen.getByLabelText('Titre'), 'Abc');
  await userEvent.click(creer());
  expect(h.calls.find((c) => c.url === '/api/topics')?.body).toEqual({
    workspaceId: 'ws_z',
    title: 'Abc',
    type: 'feat',
  });
  await waitFor(() => expect(lieu()).toBe('/sujets/tp_9'));
});

test('une création refusée par le daemon s’affiche, l’écran reste', async () => {
  const h = setup(app, deux(), '/sujets/nouveau');
  h.respond.set('POST /api/topics', json(409, { error: 'la branche feat/abc existe déjà' }));
  await waitFor(() => expect(projet()).toBe('ws_z'));
  await userEvent.type(screen.getByLabelText('Titre'), 'Abc');
  await userEvent.click(creer());
  expect((await screen.findByRole('alert')).textContent).toBe('la branche feat/abc existe déjà');
  expect(lieu()).toBe('/sujets/nouveau');
  expect(creer().disabled).toBe(false);
});

test('« Nouveau sujet » d’un projet le présélectionne par l’URL ; sinon le plus récent', async () => {
  setup(app, deux(), '/sujets/nouveau?projet=ws_a');
  await waitFor(() => expect(projet()).toBe('ws_a'));
  cleanup();
  setup(app, deux(), '/sujets/nouveau?projet=ws_inconnu');
  await waitFor(() => expect(projet()).toBe('ws_z'));
});

// B.4 (re-dev 2/2) : l'écran peut être monté avant l'hydratation de `state`
test('ouvert avant l’hydratation : le projet par défaut arrive avec l’état', async () => {
  setup(app, snapshot({ workspaces: [ws({ id: 'ws_1' })] }), '/sujets/nouveau');
  expect(projet()).toBe('');
  await userEvent.type(screen.getByLabelText('Titre'), 'Abc');
  await waitFor(() => expect(projet()).toBe('ws_1'));
  expect(creer().disabled).toBe(false);
});

test('un choix explicite de projet n’est pas écrasé par un nouvel instantané', async () => {
  const h = setup(app, deux(), '/sujets/nouveau');
  await waitFor(() => expect(projet()).toBe('ws_z'));
  await userEvent.selectOptions(screen.getByLabelText('Projet'), 'ws_a');
  h.state = snapshot({
    workspaces: [...deux().workspaces, ws({ id: 'ws_n', createdAt: '2026-10-27T00:00:00Z' })],
  });
  await pushEvent();
  expect(projet()).toBe('ws_a');
});

test('« Ajouter un projet… » ouvre l’enregistrement et revient sur l’écran, le nouveau projet choisi', async () => {
  const h = setup(app, deux(), '/sujets/nouveau?projet=ws_a');
  h.respond.set(
    'POST /api/workspaces',
    json(201, { ...ws({ id: 'ws_n', name: 'nouveau' }), warnings: [] }),
  );
  await waitFor(() => expect(projet()).toBe('ws_a'));
  await userEvent.click(screen.getByRole('button', { name: 'Ajouter un projet…' }));
  h.state = snapshot({
    workspaces: [
      ...deux().workspaces,
      ws({ id: 'ws_n', name: 'nouveau', createdAt: '2026-10-27T00:00:00Z' }),
    ],
  });
  await userEvent.click(await screen.findByRole('button', { name: 'Choisir mon-depot' }));
  await userEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
  await waitFor(() => expect(lieu()).toBe('/sujets/nouveau'));
  await waitFor(() => expect(projet()).toBe('ws_n'));
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('sans aucun projet : « Nouveau sujet » enregistre d’abord le projet, puis ouvre l’écran', async () => {
  const h = setup(app, snapshot());
  h.respond.set('POST /api/workspaces', json(201, { ...ws(), warnings: [] }));
  await userEvent.click((await screen.findAllByRole('button', { name: 'Nouveau sujet' }))[0]!);
  expect(await screen.findByRole('dialog', { name: 'Nouveau projet' })).toBeTruthy();
  h.state = snapshot({ workspaces: [ws()] });
  await userEvent.click(await screen.findByRole('button', { name: 'Choisir mon-depot' }));
  await userEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
  await waitFor(() => expect(lieu()).toBe('/sujets/nouveau'));
  await waitFor(() => expect(projet()).toBe('ws_1'));
});

test('arrivé sur l’écran sans projet : il propose d’en ajouter un', async () => {
  setup(app, snapshot(), '/sujets/nouveau');
  await waitFor(() => expect(node('nouveau-sujet.besoin.sans-projet')).not.toBeNull());
  expect(screen.queryByLabelText('Titre')).toBeNull();
  expect(creer().disabled).toBe(true);
});
