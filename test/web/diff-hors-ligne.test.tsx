// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, test, vi } from 'vitest';
import { FichierAppareil } from '../../web/src/ecrans/ParcoursAppareil.js';

const request = vi.fn();
vi.mock('../../web/src/data/useAidState.js', () => ({
  useAid: () => ({ horsLigne: true }),
  useAidClient: () => ({ request }),
}));
afterEach(cleanup);

test('D209 : hors ligne, aucune requête pour lire un diff', () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  render(
    <MemoryRouter>
      <FichierAppareil />
    </MemoryRouter>,
  );
  expect(screen.getByText('Diff indisponible hors ligne.')).toBeTruthy();
  expect(request).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  fetch.mockRestore();
});
