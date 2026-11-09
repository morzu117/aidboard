// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { MemoireSwarph } from '../../web/src/ecrans/MemoireSwarph.js';
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
const ok = (data: unknown) => ({
  ok: true,
  data,
  readAt: '2026-11-09T10:00:00Z',
  schemaVersion: null,
});
const corps = '<img src=x onerror=alert(1)>\nhttps://exemple.invalid';
const page = {
  page: ok({ slug: 'notes/test', title: 'Page test', content: corps }),
  links: ok([
    { from: 'notes/test', to: 'notes/suite', direction: 'outgoing', hop: 1 },
    { from: 'source', to: 'notes/test', direction: 'incoming', hop: 1 },
    { from: 'notes/test', to: '-invalide', direction: 'outgoing', hop: 1 },
  ]),
};
async function ouvrir(reponse = page, chemin = '/swarph/memoire?page=notes%2Ftest') {
  const h = setup(
    <>
      <MemoireSwarph />
      <Chemin />
    </>,
    etat,
    chemin,
    {
      'GET /api/nav': json(200, { groups: [], placements: [], prefs: { reduit: false } }),
      'GET /api/swarph/memory?tag=test': json(
        200,
        ok([{ slug: 'notes/test', title: 'Page test' }]),
      ),
      'GET /api/swarph/memory/page?slug=notes%2Ftest': json(200, reponse),
      'GET /api/swarph/memory/page?slug=notes%2Ftest&fresh=1': json(200, reponse),
      'GET /api/swarph/memory/page?slug=notes%2Fsuite': json(200, {
        page: ok({ slug: 'notes/suite', title: 'Suite', content: 'suite' }),
        links: ok([]),
      }),
    },
  );
  await waitFor(() => expect(FakeSocket.all.length).toBeGreaterThan(0));
  act(() => FakeSocket.all[0]!.open());
  return h;
}

test('bandeau permanent, texte brut, liens des deux directions et slug invalide inerte', async () => {
  const h = await ouvrir();
  await screen.findByRole('heading', { name: 'Page test' });
  expect(
    screen.getByText(
      "Cette mémoire est partagée par tout le mesh pour l'instant. Sa portée se réduira à ta cellule.",
    ),
  ).toBeTruthy();
  const rendu = document.querySelector('[data-node="memoire-swarph.corps"]')!;
  expect(rendu.textContent).toBe(corps);
  expect((rendu as HTMLElement).style.whiteSpace).toBe('pre-wrap');
  expect(document.querySelector('img')).toBeNull();
  expect(document.querySelector('a[href*="exemple"]')).toBeNull();
  expect(screen.getByRole('button', { name: 'source' })).toBeTruthy();
  expect(screen.getByText('-invalide').tagName).toBe('SPAN');
  fireEvent.click(screen.getByText('-invalide'));
  expect(h.calls.some((c) => c.url.includes('invalide'))).toBe(false);
  expect(screen.queryByRole('button', { name: /export|copi/i })).toBeNull();
  fireEvent.click(screen.getAllByRole('button', { name: 'Recharger' })[1]!);
  await waitFor(() =>
    expect(h.calls.some((c) => c.url.endsWith('slug=notes%2Ftest&fresh=1'))).toBe(true),
  );
  fireEvent.click(screen.getByRole('button', { name: 'notes/suite' }));
  await screen.findByRole('heading', { name: 'Suite' });
  expect(screen.getByTestId('chemin-courant').textContent).toBe(
    '/swarph/memoire?page=notes%2Fsuite',
  );
});

test('tag validé et liste ouvrant une page', async () => {
  const h = await ouvrir(page, '/swarph/memoire');
  fireEvent.change(screen.getByLabelText('Tag'), { target: { value: '-x' } });
  expect(screen.getByText(/Saisis un tag/)).toBeTruthy();
  expect(h.calls.some((c) => c.url.startsWith('/api/swarph/'))).toBe(false);
  fireEvent.change(screen.getByLabelText('Tag'), { target: { value: 'test' } });
  // aucune lecture pendant la frappe : seulement à « Lister »
  expect(h.calls.some((c) => c.url.startsWith('/api/swarph/memory?'))).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Lister' }));
  fireEvent.click(await screen.findByRole('button', { name: 'notes/test' }));
  await screen.findByRole('heading', { name: 'Page test' });
});

test.each([
  ['forbidden', "Ta cellule n'a pas, ou plus, accès à cette mémoire."],
  ['not-configured', "Le gateway n'est pas configuré pour la mémoire."],
])('%s est un état normal', async (kind, texte) => {
  await ouvrir({
    page: { ok: false, kind, readAt: null },
    links: ok([]),
  } as unknown as typeof page);
  const message = await screen.findByText(texte);
  expect(message.closest('[role="alert"]')).toBeNull();
  expect(message.className).not.toContain('erreur');
});

test('slug invalide dans URL : aucune lecture', async () => {
  const h = await ouvrir(page, '/swarph/memoire?page=-invalide');
  expect(screen.getByText('Slug invalide.')).toBeTruthy();
  expect(h.calls.some((c) => c.url.startsWith('/api/swarph/'))).toBe(false);
});
