// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { Federation } from '../../web/src/ecrans/Federation.js';
import { Chemin, FakeSocket, json, setup, snapshot } from './helpers.js';

afterEach(cleanup);
const etat = snapshot({
  mesh: {
    state: {
      connected: true,
      tailscale: 'running',
      monitor: 'running',
      pending: 0,
      since: null,
      cell: 'peer-a',
    },
    inbox: [],
    tailscaleManage: false,
  },
});
const lecture = {
  ok: true,
  data: {
    lignes: [
      {
        name: 'lecture',
        qualified_name: 'exemple.lecture',
        kind: 'function',
        repo: 'exemple',
        file_path: 'src/lecture.ts',
        start_line: 12,
        callers: 2,
        signature: 'lecture(): void',
        docstring: '<img src=x onerror=alert(1)>',
      },
    ],
    perime: true,
  },
  readAt: '2026-11-09T10:00:00Z',
  schemaVersion: null,
};
async function ouvrir(reponse = lecture, chemin = '/swarph/federation') {
  const h = setup(
    <>
      <Federation />
      <Chemin />
    </>,
    etat,
    chemin,
    {
      'GET /api/nav': json(200, { groups: [], placements: [], prefs: { reduit: false } }),
      'GET /api/swarph/federation?q=test': json(200, reponse),
      'GET /api/swarph/federation?q=test&fresh=1': json(200, reponse),
    },
  );
  await waitFor(() => expect(FakeSocket.all.length).toBeGreaterThan(0));
  act(() => FakeSocket.all[0]!.open());
  return h;
}

test.each([
  ['', 'Saisis une requête.'],
  ['-x', 'commencer'],
  ['x'.repeat(201), '200 caractères'],
  ['x\u0001', 'contrôle'],
])('validation %j et aucune lecture pendant la frappe', async (valeur, raison) => {
  const h = await ouvrir();
  fireEvent.change(screen.getByLabelText('Requête'), { target: { value: valeur } });
  expect(screen.getByRole('button', { name: 'Chercher' }).hasAttribute('disabled')).toBe(true);
  expect(document.querySelector('[data-node="federation.raison"]')!.textContent).toContain(raison);
  expect(h.calls.filter((c) => c.url.startsWith('/api/swarph/'))).toEqual([]);
});

test('soumission, URL partageable, saisie indépendante, périmé, docstring et fresh', async () => {
  const h = await ouvrir();
  fireEvent.change(screen.getByLabelText('Requête'), { target: { value: 'test' } });
  expect(h.calls.filter((c) => c.url.startsWith('/api/swarph/'))).toEqual([]);
  fireEvent.submit(screen.getByRole('button', { name: 'Chercher' }).closest('form')!);
  await screen.findByText('exemple.lecture');
  expect(screen.getByTestId('chemin-courant').textContent).toBe('/swarph/federation?q=test');
  expect(screen.getByText('Index périmé : les numéros de ligne ont pu bouger')).toBeTruthy();
  expect(screen.getByText('Docstring').closest('details')!.open).toBe(false);
  expect(document.querySelector('img')).toBeNull();
  const nombre = h.calls.filter((c) => c.url.startsWith('/api/swarph/')).length;
  fireEvent.change(screen.getByLabelText('Requête'), { target: { value: 'autre' } });
  expect(h.calls.filter((c) => c.url.startsWith('/api/swarph/'))).toHaveLength(nombre);
  fireEvent.click(screen.getByRole('button', { name: 'Recharger' }));
  await waitFor(() => expect(h.calls.some((c) => c.url.endsWith('q=test&fresh=1'))).toBe(true));
  expect(screen.getByText(/Lu à/).textContent).not.toContain('—');
});

test('lecture depuis q au chargement et état no-index exact', async () => {
  const reponse = { ok: false, kind: 'no-index', readAt: lecture.readAt };
  // Une réponse discriminée d’erreur occupe le même endpoint.
  await ouvrir(reponse as unknown as typeof lecture, '/swarph/federation?q=test');
  expect(
    await screen.findByText(
      "Aucun index local. Ce n'est pas un résultat négatif : rien n'a été cherché.",
    ),
  ).toBeTruthy();
});
