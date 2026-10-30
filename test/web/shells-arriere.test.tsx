// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { ShellsEnArriere, shellsVivants } from '../../web/src/ui/Statut.js';
import { agent } from './helpers.js';

afterEach(cleanup);

const shell = (over = {}) => agent({ kind: 'shell', status: 'working', ...over });
const claude = (over = {}) =>
  agent({ kind: 'claude', transport: 'stream', status: 'working', ...over });

test('shellsVivants : seuls les shells non terminés comptent', () => {
  expect(
    shellsVivants([
      shell({ id: 'a' }),
      shell({ id: 'b', status: 'idle' }),
      shell({ id: 'c', status: 'stopped' }),
      shell({ id: 'd', status: 'done' }),
      claude({ id: 'e' }),
    ]),
  ).toBe(2);
});

test('un shell seul : l’icône dit qu’un shell tourne en arrière-plan, sans compteur', () => {
  render(<ShellsEnArriere agents={[shell()]} />);
  expect(screen.getByRole('img', { name: '1 shell en arrière-plan' })).toBeTruthy();
  expect(document.body.textContent).toBe('');
});

test('un agent en veille et plusieurs shells : l’icône donne le nombre', () => {
  render(
    <ShellsEnArriere
      agents={[claude({ id: 'c', status: 'stopped' }), shell({ id: 'a' }), shell({ id: 'b' })]}
    />,
  );
  expect(screen.getByRole('img', { name: '2 shells en arrière-plan' })).toBeTruthy();
  expect(document.body.textContent).toBe('2');
});

test('un agent qui a un statut à montrer : le point parle, pas d’icône', () => {
  const { container } = render(<ShellsEnArriere agents={[claude(), shell()]} />);
  expect(container.firstChild).toBeNull();
});

test('aucun shell vivant (aucun agent, ou shell terminé) : pas d’icône', () => {
  const vide = render(<ShellsEnArriere agents={[]} />);
  expect(vide.container.firstChild).toBeNull();
  const termine = render(<ShellsEnArriere agents={[shell({ status: 'stopped' })]} />);
  expect(termine.container.firstChild).toBeNull();
});
