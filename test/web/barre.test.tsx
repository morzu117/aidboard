// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { afterEach, expect, test, vi } from 'vitest';
import type { NavState, Topic } from '../../src/shared/model.js';
import type { StateSnapshot } from '../../src/shared/state.js';
import { Accueil } from '../../web/src/ecrans/Accueil.js';
import { Boite } from '../../web/src/ecrans/Boite.js';
import { Consignes } from '../../web/src/ecrans/Consignes.js';
import { Reglages } from '../../web/src/ecrans/Reglages.js';
import { Sujet } from '../../web/src/ecrans/Sujet.js';
import { filterItems, isPaletteShortcut } from '../../web/src/ui/Palette.js';
import { agent, json, setup, snapshot, topic, ws } from './helpers.js';

vi.mock('../../web/src/terminal/Terminal.js', () => ({
  Terminal: ({ agentId }: { agentId: string }) => (
    <div className="xterm" data-testid={`term-${agentId}`} tabIndex={0} />
  ),
}));

afterEach(cleanup);
const node = (id: string) => document.querySelector(`[data-node="${id}"]`) as HTMLElement | null;
const app = (
  <Routes>
    <Route path="/" element={<Accueil />} />
    <Route path="/boite" element={<Boite />} />
    <Route path="/consignes" element={<Consignes />} />
    <Route path="/reglages" element={<Reglages />} />
    <Route path="/sujets/:topicId" element={<Sujet />} />
  </Routes>
);
const state = (over = {}) =>
  snapshot({
    workspaces: [ws()],
    topics: [
      topic(),
      topic({ id: 'tp_2', title: 'Exporter en CSV', branch: 'feat/csv', slug: 'csv' }),
    ],
    runs: [{ id: 'run_1', topicId: 'tp_1', mode: 'standard', state: 'open', createdAt: 't' }],
    ...over,
  });
// La table de l'Accueil (D56, point 5) n'affiche un sujet que placé — comme en vrai, où
// `ensureNavDefaults` en pose un à chaque sujet ; ici il faut le simuler explicitement.
const navFor = (topics: Topic[]): NavState => ({
  groups: [],
  placements: topics.map((t, i) => ({
    topicId: t.id,
    groupId: 'ng_1',
    ord: i,
    pinned: false,
    archived: false,
    hidden: false,
    displayName: null,
  })),
  prefs: { reduit: false },
});
const ouvrir = (over: Partial<StateSnapshot> = {}) => {
  const snap = state(over);
  return setup(app, snap, '/', { 'GET /api/nav': json(200, navFor(snap.topics)) });
};
const attendreTable = () => waitFor(() => expect(node('1-1.table.ligne-1')).not.toBeNull());

test('liens : chacun mène à son écran, l’actif suit la route', async () => {
  ouvrir();
  await attendreTable();
  expect(node('1-1.barre.nav-accueil')?.getAttribute('aria-current')).toBe('page');
  expect(node('1-1.barre.nav-boite')?.getAttribute('aria-current')).toBeNull();
  for (const [lien, ecran, titre] of [
    ['nav-boite', '1-2', 'Boîte de réception'],
    ['nav-consignes', 'consignes', 'Consignes'],
    ['nav-reglages', 'reglages', 'Réglages'],
  ] as const) {
    await userEvent.click(document.querySelector(`[data-node$=".barre.${lien}"]`)!);
    expect(node(`${ecran}.entete.titre`)?.textContent).toBe(titre);
    const actif = node(`${ecran}.barre.${lien}`)!;
    expect(actif.className).toContain('est-actif');
    expect(actif.getAttribute('aria-current')).toBe('page');
    expect(document.querySelectorAll('.nav-lien.est-actif')).toHaveLength(1);
  }
  // le relais n'existe pas encore : pas de pastille
  expect(document.querySelector('[data-node$=".barre.relais"]')).toBeNull();
});

test('compteur : les agents qui attendent une réponse, caché à zéro', async () => {
  ouvrir();
  await attendreTable();
  expect(node('1-1.barre.nav-boite.compte')).toBeNull();
  cleanup();
  ouvrir({
    agents: [
      agent({ status: 'needs_input' }),
      agent({ id: 'ag_2', status: 'needs_input' }),
      agent({ id: 'ag_3', status: 'working' }),
    ],
  });
  await attendreTable();
  expect(node('1-1.barre.nav-boite.compte')?.textContent).toBe('2');
});

// Le <select> de tri de l'Accueil (C.1) porte aussi, en ARIA, les rôles combobox/option : les
// requêtes palette doivent être bornées à son dialogue, jamais globales au document.
const nomPalette = 'Rechercher ou lancer une action';

test('palette : ⌘K l’ouvre, la saisie filtre, les flèches et Entrée ouvrent le sujet', async () => {
  ouvrir();
  await attendreTable();
  fireEvent.keyDown(document.body, { key: 'k', metaKey: true });
  const palette = await screen.findByRole('dialog', { name: nomPalette });
  const champ = within(palette).getByRole('combobox');
  expect(document.activeElement).toBe(champ);
  expect(node('palette.sujet-tp_1')).not.toBeNull();
  expect(node('palette.ecran-reglages')).not.toBeNull();
  await userEvent.type(champ, 'feat');
  expect(
    within(palette)
      .getAllByRole('option')
      .map((o) => o.textContent),
  ).toEqual(['Mon sujetaid · feat/s', 'Exporter en CSVaid · feat/csv']);
  await userEvent.keyboard('{ArrowDown}');
  expect(node('palette.sujet-tp_2')?.getAttribute('aria-selected')).toBe('true');
  await userEvent.keyboard('{Enter}');
  expect(screen.queryByRole('dialog', { name: nomPalette })).toBeNull();
  expect(await screen.findByText('Exporter en CSV', { selector: 'h1' })).toBeTruthy();
});

test('palette : le bouton l’ouvre, Échap la ferme, « Nouveau sujet » ouvre le dialogue', async () => {
  ouvrir();
  await attendreTable();
  await userEvent.click(node('1-1.barre.recherche')!);
  await userEvent.keyboard('{Escape}');
  expect(screen.queryByRole('dialog', { name: nomPalette })).toBeNull();
  await userEvent.click(node('1-1.barre.recherche')!);
  const palette = screen.getByRole('dialog', { name: nomPalette });
  await userEvent.type(within(palette).getByRole('combobox'), 'nouveau');
  expect(within(palette).getAllByRole('option')).toHaveLength(1);
  await userEvent.keyboard('{Enter}');
  expect(await screen.findByRole('dialog', { name: 'Nouveau sujet' })).toBeTruthy();
});

test('⌘K n’est pas capté dans un terminal : Ctrl+K y efface la fin de ligne', () => {
  const term = document.createElement('div');
  term.className = 'xterm';
  const area = document.createElement('textarea');
  term.append(area);
  document.body.append(term);
  expect(isPaletteShortcut({ key: 'k', ctrlKey: true, metaKey: false, target: area })).toBe(false);
  expect(
    isPaletteShortcut({ key: 'K', ctrlKey: false, metaKey: true, target: document.body }),
  ).toBe(true);
  expect(
    isPaletteShortcut({ key: 'k', ctrlKey: false, metaKey: false, target: document.body }),
  ).toBe(false);
  term.remove();
});

test('filtrage : tous les mots, sans accents', () => {
  const items = [
    { id: 'a', label: 'Réglages', hint: 'écran', run: () => {} },
    { id: 'b', label: 'Boîte de réception', hint: 'écran', run: () => {} },
  ];
  expect(filterItems(items, 'reg').map((i) => i.id)).toEqual(['a']);
  expect(filterItems(items, 'boite ecran').map((i) => i.id)).toEqual(['b']);
  expect(filterItems(items, '  ').map((i) => i.id)).toEqual(['a', 'b']);
  expect(filterItems(items, 'xyz')).toEqual([]);
});
