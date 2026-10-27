// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { ContextMenu, type MenuItem } from '../../web/src/ui/ContextMenu.js';

afterEach(cleanup);

const items = (over: Partial<MenuItem>[] = []): MenuItem[] => [
  { id: 'un', label: 'Un', onSelect: vi.fn() },
  { id: 'deux', label: 'Deux', onSelect: vi.fn() },
  { id: 'trois', label: 'Trois', onSelect: vi.fn() },
  ...(over as MenuItem[]),
];

test('role="menu" avec des menuitem, le premier reçoit le focus au montage', async () => {
  const onClose = vi.fn();
  render(<ContextMenu items={items()} label="Actions" onClose={onClose} />);
  expect(screen.getByRole('menu', { name: 'Actions' })).toBeTruthy();
  const entrees = screen.getAllByRole('menuitem');
  expect(entrees.map((e) => e.textContent)).toEqual(['Un', 'Deux', 'Trois']);
  expect(document.activeElement).toBe(entrees[0]);
});

test('flèche bas/haut déplace le focus, boucle aux extrémités', async () => {
  const onClose = vi.fn();
  render(<ContextMenu items={items()} label="Actions" onClose={onClose} />);
  const [un, deux, trois] = screen.getAllByRole('menuitem');
  await userEvent.keyboard('{ArrowDown}');
  expect(document.activeElement).toBe(deux);
  await userEvent.keyboard('{ArrowDown}');
  expect(document.activeElement).toBe(trois);
  await userEvent.keyboard('{ArrowDown}');
  expect(document.activeElement).toBe(un);
  await userEvent.keyboard('{ArrowUp}');
  expect(document.activeElement).toBe(trois);
});

test('Entrée active l’entrée focalisée et ferme le menu', async () => {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  render(
    <ContextMenu
      items={items([{ id: 'quatre', label: 'Quatre', onSelect }])}
      label="Actions"
      onClose={onClose}
    />,
  );
  await userEvent.keyboard('{ArrowUp}'); // boucle vers « Quatre », dernière entrée
  await userEvent.keyboard('{Enter}');
  expect(onSelect).toHaveBeenCalledTimes(1);
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('Échap ferme le menu sans activer d’entrée', async () => {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  render(
    <ContextMenu items={[{ id: 'un', label: 'Un', onSelect }]} label="Actions" onClose={onClose} />,
  );
  await userEvent.keyboard('{Escape}');
  expect(onSelect).not.toHaveBeenCalled();
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('un clic extérieur ferme le menu', async () => {
  const onClose = vi.fn();
  render(
    <div>
      <button type="button">Ailleurs</button>
      <ContextMenu items={items()} label="Actions" onClose={onClose} />
    </div>,
  );
  await userEvent.click(screen.getByRole('button', { name: 'Ailleurs' }));
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('un clic sur une entrée désactivée ne l’active pas', async () => {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  render(
    <ContextMenu
      items={[{ id: 'un', label: 'Un', onSelect, disabled: true }]}
      label="Actions"
      onClose={onClose}
    />,
  );
  await userEvent.click(screen.getByRole('menuitem', { name: 'Un' }));
  expect(onSelect).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
});

test('flèche bas traverse un item désactivé (focalisable), Entrée sur un désactivé ne fait rien', async () => {
  const onSelectDeux = vi.fn();
  const onClose = vi.fn();
  render(
    <ContextMenu
      items={[
        { id: 'un', label: 'Un', onSelect: vi.fn() },
        { id: 'deux', label: 'Deux', onSelect: onSelectDeux, disabled: true },
        { id: 'trois', label: 'Trois', onSelect: vi.fn() },
      ]}
      label="Actions"
      onClose={onClose}
    />,
  );
  const [, deux, trois] = screen.getAllByRole('menuitem');
  await userEvent.keyboard('{ArrowDown}');
  expect(document.activeElement).toBe(deux);
  await userEvent.keyboard('{Enter}');
  expect(onSelectDeux).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  await userEvent.keyboard('{ArrowDown}');
  expect(document.activeElement).toBe(trois);
});

test('Tab ferme le menu sans activer d’entrée', async () => {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  render(
    <ContextMenu items={[{ id: 'un', label: 'Un', onSelect }]} label="Actions" onClose={onClose} />,
  );
  await userEvent.keyboard('{Tab}');
  expect(onSelect).not.toHaveBeenCalled();
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('Shift+Tab ferme aussi le menu', async () => {
  const onClose = vi.fn();
  render(
    <ContextMenu
      items={[{ id: 'un', label: 'Un', onSelect: vi.fn() }]}
      label="Actions"
      onClose={onClose}
    />,
  );
  await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('un sous-menu se déplie au clic et ses entrées sont navigables aux flèches', async () => {
  const onSelectSous = vi.fn();
  const onClose = vi.fn();
  render(
    <ContextMenu
      items={[
        {
          id: 'parent',
          label: 'Déplacer vers…',
          submenu: [{ id: 'cible', label: 'Groupe A', onSelect: onSelectSous }],
        },
      ]}
      label="Actions"
      onClose={onClose}
    />,
  );
  expect(screen.queryByRole('menuitem', { name: 'Groupe A' })).toBeNull();
  await userEvent.click(screen.getByRole('menuitem', { name: 'Déplacer vers…' }));
  const sousEntree = screen.getByRole('menuitem', { name: 'Groupe A' });
  expect(sousEntree).toBeTruthy();
  await userEvent.click(sousEntree);
  expect(onSelectSous).toHaveBeenCalledTimes(1);
  expect(onClose).toHaveBeenCalledTimes(1);
});
