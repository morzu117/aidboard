// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { afterEach, expect, test, vi } from 'vitest';
import { Accueil } from '../../web/src/ecrans/Accueil.js';
import { Boite } from '../../web/src/ecrans/Boite.js';
import { Consignes } from '../../web/src/ecrans/Consignes.js';
import { Reglages } from '../../web/src/ecrans/Reglages.js';
import { Sujet } from '../../web/src/ecrans/Sujet.js';
import { filterItems, isPaletteShortcut } from '../../web/src/ui/Palette.js';
import { agent, setup, snapshot, topic, ws } from './helpers.js';

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

test('liens : chacun mène à son écran, l’actif suit la route', async () => {
  setup(app, state());
  await screen.findByText('Mon sujet');
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
  setup(app, state());
  await screen.findByText('Mon sujet');
  expect(node('1-1.barre.nav-boite.compte')).toBeNull();
  cleanup();
  setup(
    app,
    state({
      agents: [
        agent({ status: 'needs_input' }),
        agent({ id: 'ag_2', status: 'needs_input' }),
        agent({ id: 'ag_3', status: 'working' }),
      ],
    }),
  );
  await screen.findByText('Mon sujet');
  expect(node('1-1.barre.nav-boite.compte')?.textContent).toBe('2');
});

test('palette : ⌘K l’ouvre, la saisie filtre, les flèches et Entrée ouvrent le sujet', async () => {
  setup(app, state());
  await screen.findByText('Mon sujet');
  fireEvent.keyDown(document.body, { key: 'k', metaKey: true });
  const champ = await screen.findByRole('combobox');
  expect(document.activeElement).toBe(champ);
  expect(node('palette.sujet-tp_1')).not.toBeNull();
  expect(node('palette.ecran-reglages')).not.toBeNull();
  await userEvent.type(champ, 'feat');
  expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
    'Mon sujetaid · feat/s',
    'Exporter en CSVaid · feat/csv',
  ]);
  await userEvent.keyboard('{ArrowDown}');
  expect(node('palette.sujet-tp_2')?.getAttribute('aria-selected')).toBe('true');
  await userEvent.keyboard('{Enter}');
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(await screen.findByText('Exporter en CSV', { selector: 'h1' })).toBeTruthy();
});

test('palette : le bouton l’ouvre, Échap la ferme, « Nouveau sujet » ouvre le dialogue', async () => {
  setup(app, state());
  await screen.findByText('Mon sujet');
  await userEvent.click(node('1-1.barre.recherche')!);
  await userEvent.keyboard('{Escape}');
  expect(screen.queryByRole('combobox')).toBeNull();
  await userEvent.click(node('1-1.barre.recherche')!);
  await userEvent.type(screen.getByRole('combobox'), 'nouveau');
  expect(screen.getAllByRole('option')).toHaveLength(1);
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
