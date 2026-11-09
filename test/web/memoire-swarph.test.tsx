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
      'GET /api/swarph/memory': json(200, ok([])),
      'GET /api/swarph/memory?type=note': json(200, ok([])),
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
  fireEvent.change(screen.getByLabelText('Filtre'), { target: { value: 'tag' } });
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

test('type invalide expliqué et Lister désactivé, puis type valide sans message', async () => {
  await ouvrir(page, '/swarph/memoire');
  fireEvent.change(screen.getByLabelText('Filtre'), { target: { value: 'type' } });
  const message =
    'Saisis un type de 1 à 64 caractères : minuscules, chiffres, soulignement ou tiret, en commençant par une lettre.';
  const lister = screen.getByRole('button', { name: 'Lister' }) as HTMLButtonElement;
  for (const valeur of ['', 'Note']) {
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: valeur } });
    expect(screen.getByText(message).getAttribute('data-node')).toBe('memoire-swarph.raison');
    expect(lister.disabled).toBe(true);
  }
  fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'note' } });
  expect(screen.queryByText(message)).toBeNull();
  expect(lister.disabled).toBe(false);
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

test('Tous par défaut, champ selon le filtre et type envoyé seulement au clic', async () => {
  const h = await ouvrir(page, '/swarph/memoire');
  expect((screen.getByLabelText('Filtre') as HTMLSelectElement).value).toBe('tous');
  expect(screen.queryByRole('textbox')).toBeNull();
  expect((screen.getByRole('button', { name: 'Lister' }) as HTMLButtonElement).disabled).toBe(
    false,
  );
  expect(h.calls.some((c) => c.url.startsWith('/api/swarph/'))).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Lister' }));
  await waitFor(() => expect(h.calls.some((c) => c.url === '/api/swarph/memory')).toBe(true));
  await waitFor(() =>
    expect((screen.getByRole('button', { name: 'Lister' }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
  fireEvent.change(screen.getByLabelText('Filtre'), { target: { value: 'type' } });
  expect(
    screen.getByText('Le type peut être reclassé par le cerveau ; le tag est plus fiable.'),
  ).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'note' } });
  expect(h.calls.some((c) => c.url.includes('type='))).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Lister' }));
  await waitFor(() =>
    expect(h.calls.some((c) => c.url === '/api/swarph/memory?type=note')).toBe(true),
  );
  fireEvent.change(screen.getByLabelText('Filtre'), { target: { value: 'tous' } });
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.queryByText(/Le type peut être reclassé/)).toBeNull();
});
