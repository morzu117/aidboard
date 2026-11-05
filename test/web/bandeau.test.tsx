// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { Bandeau } from '../../web/src/ui/Bandeau.js';

afterEach(cleanup);

const node = (c: HTMLElement, n: string) => c.querySelector(`[data-node="${n}"]`);

test('D110 : constat, ce qui continue, détail et action ; le ton a toujours un libellé', () => {
  const onClick = vi.fn();
  const { container } = render(
    <Bandeau
      ton="ambre"
      constat="Board indisponible"
      continue="Le travail local continue."
      action={{ label: 'Réessayer', onClick }}
      node="board.bandeau"
    >
      Dernière lecture il y a 3 min
    </Bandeau>,
  );
  const b = node(container, 'board.bandeau')!;
  expect(b.getAttribute('role')).toBe('alert');
  expect(b.getAttribute('data-ton')).toBe('ambre');
  expect(node(container, 'board.bandeau.ton')!.textContent).toBe('À surveiller');
  expect(node(container, 'board.bandeau.constat')!.textContent).toBe('Board indisponible');
  expect(node(container, 'board.bandeau.detail')!.textContent).toBe(
    'Dernière lecture il y a 3 min',
  );
  expect(node(container, 'board.bandeau.continue')!.textContent).toBe('Le travail local continue.');
  fireEvent.click(node(container, 'board.bandeau.action')!);
  expect(onClick).toHaveBeenCalledOnce();
});

test('D110 : neutre se lit en status, sans action ni détail ; une action en cours est désactivée', () => {
  const { container, rerender } = render(<Bandeau ton="neutre" constat="Info" node="x" />);
  expect(node(container, 'x')!.getAttribute('role')).toBe('status');
  expect(node(container, 'x.ton')!.textContent).toBe('Information');
  expect(node(container, 'x.action')).toBeNull();
  expect(node(container, 'x.detail')).toBeNull();
  expect(node(container, 'x.continue')).toBeNull();
  rerender(
    <Bandeau
      ton="rouge"
      constat="Session perdue"
      action={{ label: 'Reprendre…', onClick: () => {}, enCours: true }}
      node="x"
    />,
  );
  expect(node(container, 'x.ton')!.textContent).toBe('Bloqué');
  expect((node(container, 'x.action') as HTMLButtonElement).disabled).toBe(true);
});
