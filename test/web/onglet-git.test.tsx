// @vitest-environment jsdom
// correctif 4 (recette) : l'onglet Git du panneau passe d'une grille liste + détail côte à côte
// à une bascule liste <-> détail en une colonne (brief §5.3.3 « Git »).
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test } from 'vitest';
import { PanneauContexte } from '../../web/src/ecrans/PanneauContexte.js';
import { json, setup, snapshot } from './helpers.js';

afterEach(cleanup);

const HASH_SUJET = 'b222222222222222222222222222222222222222';
const HASH_BASE = 'a111111111111111111111111111111111111111';
const MESSAGE_SUJET =
  'Correctif du panneau contextuel : le détail du commit remplace la liste au lieu de s’écraser à côté';
const MESSAGE_BASE = 'Commit de base';

const GIT_LOG = json(200, {
  commits: [
    {
      hash: HASH_SUJET,
      parents: [HASH_BASE],
      author: 'Alice',
      date: '2026-10-20T10:00:00.000Z',
      message: MESSAGE_SUJET,
      refs: [],
      inHead: true,
    },
    {
      hash: HASH_BASE,
      parents: [],
      author: 'Bob',
      date: '2026-10-19T09:00:00.000Z',
      message: MESSAGE_BASE,
      refs: ['main'],
      inHead: true,
    },
  ],
  dirty: false,
  live: { aheadBehind: { ahead: 1, behind: 0 }, rebaseInProgress: false, onTopicBranch: true },
});

const detailDe = (hash: string, message: string) =>
  json(200, {
    hash,
    parents: [],
    author: 'Alice',
    date: '2026-10-20T10:00:00.000Z',
    message,
    body: '',
    refs: [],
    inHead: true,
    files: [],
  });

const panneau = () => (
  <PanneauContexte
    namespace="aid"
    topicSlug="s"
    topicId="tp_1"
    base="main"
    remote={null}
    activeAgentId={null}
    initialOnglet="git"
  />
);

const routes = {
  'GET /api/topics/tp_1/git/log': GIT_LOG,
  [`GET /api/topics/tp_1/git/commits/${encodeURIComponent(HASH_SUJET)}`]: detailDe(
    HASH_SUJET,
    MESSAGE_SUJET,
  ),
  [`GET /api/topics/tp_1/git/commits/${encodeURIComponent(HASH_BASE)}`]: detailDe(
    HASH_BASE,
    MESSAGE_BASE,
  ),
};

test('clic sur un commit : le détail remplace la liste ; Retour ramène à la liste avec filtre et recherche conservés', async () => {
  setup(panneau(), snapshot(), '/', routes);
  await screen.findByText(MESSAGE_SUJET);
  await userEvent.click(screen.getByRole('button', { name: 'Sujet seul' }));
  await userEvent.type(screen.getByRole('textbox', { name: 'Filtrer les commits' }), 'panneau');
  expect(await screen.findByText(MESSAGE_SUJET)).toBeTruthy();

  await userEvent.click(screen.getByText(MESSAGE_SUJET));
  expect(await screen.findByRole('heading', { name: MESSAGE_SUJET })).toBeTruthy();
  expect(screen.queryByRole('list', { name: 'Commits' })).toBeNull();

  await userEvent.click(screen.getByRole('button', { name: '← Retour' }));
  expect(await screen.findByRole('list', { name: 'Commits' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Sujet seul' }).getAttribute('aria-pressed')).toBe(
    'true',
  );
  expect(
    (screen.getByRole('textbox', { name: 'Filtrer les commits' }) as HTMLInputElement).value,
  ).toBe('panneau');
  expect(screen.getByText(MESSAGE_SUJET)).toBeTruthy();
});

test('Échap dans le détail équivaut à Retour', async () => {
  setup(panneau(), snapshot(), '/', routes);
  await userEvent.click(await screen.findByText(MESSAGE_SUJET));
  await screen.findByRole('heading', { name: MESSAGE_SUJET });
  await userEvent.keyboard('{Escape}');
  expect(await screen.findByRole('list', { name: 'Commits' })).toBeTruthy();
  expect(screen.queryByRole('heading', { name: MESSAGE_SUJET })).toBeNull();
});

test('« Voir la base » ouvre le détail du commit de base', async () => {
  setup(panneau(), snapshot(), '/', routes);
  await screen.findByText(MESSAGE_SUJET);
  await userEvent.click(screen.getByRole('button', { name: 'Voir la base' }));
  expect(await screen.findByRole('heading', { name: MESSAGE_BASE })).toBeTruthy();
  expect(screen.queryByRole('list', { name: 'Commits' })).toBeNull();
});

const routeDetail = (hash: string) =>
  `GET /api/topics/tp_1/git/commits/${encodeURIComponent(hash)}`;

// review, point 1 : une réponse de détail en retard sur un commit qui n'est plus la
// sélection courante (Retour, puis une autre sélection) ne doit pas écraser l'affichage.
test('une réponse de détail arrivée en retard n’écrase pas le commit actuellement affiché', async () => {
  let resoudreA!: (r: Response) => void;
  let resoudreB!: (r: Response) => void;
  setup(panneau(), snapshot(), '/', {
    ...routes,
    [routeDetail(HASH_SUJET)]: () =>
      new Promise<Response>((r) => (resoudreA = r)) as unknown as Response,
    [routeDetail(HASH_BASE)]: () =>
      new Promise<Response>((r) => (resoudreB = r)) as unknown as Response,
  });
  await screen.findByText(MESSAGE_SUJET);
  await userEvent.click(screen.getByText(MESSAGE_SUJET));
  await userEvent.click(await screen.findByRole('button', { name: '← Retour' }));
  await screen.findByRole('list', { name: 'Commits' });
  await userEvent.click(screen.getByRole('button', { name: 'Voir la base' }));
  resoudreB(detailDe(HASH_BASE, MESSAGE_BASE)());
  expect(await screen.findByRole('heading', { name: MESSAGE_BASE })).toBeTruthy();
  resoudreA(detailDe(HASH_SUJET, MESSAGE_SUJET)());
  await new Promise((r) => setTimeout(r, 20));
  expect(screen.queryByRole('heading', { name: MESSAGE_SUJET })).toBeNull();
  expect(screen.getByRole('heading', { name: MESSAGE_BASE })).toBeTruthy();
});

// review, point 1 : même garde côté erreur — une erreur périmée ne doit apparaître ni
// dans la liste, ni se glisser sous le détail suivant.
test('une erreur de détail arrivée après un Retour ne s’affiche ni dans la liste ni au prochain détail', async () => {
  let rejeterA!: (e: unknown) => void;
  setup(panneau(), snapshot(), '/', {
    ...routes,
    [routeDetail(HASH_SUJET)]: () =>
      new Promise<Response>((_r, rej) => (rejeterA = rej)) as unknown as Response,
  });
  await screen.findByText(MESSAGE_SUJET);
  await userEvent.click(screen.getByText(MESSAGE_SUJET));
  await userEvent.click(await screen.findByRole('button', { name: '← Retour' }));
  await screen.findByRole('list', { name: 'Commits' });
  rejeterA(new Error('boom'));
  await new Promise((r) => setTimeout(r, 20));
  expect(screen.queryByRole('alert')).toBeNull();
  await userEvent.click(screen.getByText(MESSAGE_BASE));
  expect(await screen.findByRole('heading', { name: MESSAGE_BASE })).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});

// review, point 2 : le focus revient au commit qui avait été ouvert, pas à <body>.
test('le focus revient au bouton du commit ouvert après Retour, et après Échap', async () => {
  setup(panneau(), snapshot(), '/', routes);
  await screen.findByText(MESSAGE_SUJET);
  await userEvent.click(screen.getByText(MESSAGE_SUJET));
  await userEvent.click(await screen.findByRole('button', { name: '← Retour' }));
  await screen.findByRole('list', { name: 'Commits' });
  // le retour démonte le panneau détail : le bouton d'avant n'existe plus, on le requête à neuf.
  expect(document.activeElement).toBe(screen.getByText(MESSAGE_SUJET).closest('button'));

  await userEvent.click(screen.getByText(MESSAGE_SUJET));
  await screen.findByRole('button', { name: '← Retour' });
  await userEvent.keyboard('{Escape}');
  await screen.findByRole('list', { name: 'Commits' });
  expect(document.activeElement).toBe(screen.getByText(MESSAGE_SUJET).closest('button'));
});
