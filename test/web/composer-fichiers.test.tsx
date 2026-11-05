// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import type { FilesResponse } from '../../src/shared/files.js';
import { Composer } from '../../web/src/conversation/Composer.js';
import { AidClient } from '../../web/src/data/client.js';
import { AidProvider } from '../../web/src/data/useAidState.js';
import { snapshot } from './helpers.js';

/** Chantier 26 (D118) : `@` dans le composer d'un agent de sujet liste les fichiers du worktree. */

afterEach(cleanup);

const arbre = (truncated = false): FilesResponse => ({
  tree: [
    { name: 'app.ts', path: 'src/app.ts', kind: 'file', status: '' },
    { name: 'mapper.ts', path: 'src/mapper.ts', kind: 'file', status: '' },
  ],
  total: 2,
  modified: 0,
  truncated,
});

function monter(topicId: string | undefined, reponse = arbre()) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url === '/api/state') return new Response(JSON.stringify(snapshot()), { status: 200 });
    if (url.startsWith('/api/topics/tp_1/files'))
      return new Response(JSON.stringify(reponse), { status: 200 });
    return new Response('{}', { status: 202 });
  }) as unknown as typeof fetch;
  const client = new AidClient({
    fetchImpl,
    socketFactory: () => ({ close() {} }) as unknown as WebSocket,
    backoffMs: [20],
    debounceMs: 5,
  });
  render(
    <AidProvider client={client}>
      <Composer agentId="ag_1" kind="claude" status="idle" dataNode="cv" topicId={topicId} />
    </AidProvider>,
  );
  const champ = screen.getByRole('textbox', { name: 'Message à claude' }) as HTMLTextAreaElement;
  const lectures = () => calls.filter((c) => c.url.startsWith('/api/topics/tp_1/files'));
  return { calls, champ, lectures };
}

const options = () =>
  Array.from(document.querySelectorAll('[data-node="cv.mention"] [role="option"]')).map(
    (o) => o.textContent,
  );

test('@ ouvre la liste, une seule lecture ; la saisie filtre ; Entrée insère le chemin sans envoyer', async () => {
  const { calls, champ, lectures } = monter('tp_1');
  await userEvent.type(champ, 'voir @');
  await waitFor(() => expect(options()).toEqual(['@src/app.ts', '@src/mapper.ts']));
  expect(lectures().map((c) => c.url)).toEqual(['/api/topics/tp_1/files?scope=tout']);
  await userEvent.type(champ, 'map');
  expect(options()).toEqual(['@src/mapper.ts']);
  expect(lectures()).toHaveLength(1);
  await userEvent.keyboard('{Enter}');
  expect(champ.value).toBe('voir @src/mapper.ts ');
  expect(document.querySelector('[data-node="cv.mention"]')).toBeNull();
  expect(calls.some((c) => c.method === 'POST')).toBe(false);
});

test('↓ choisit, un clic insère ; Échap ferme ; sans correspondance, la liste le dit', async () => {
  const { champ } = monter('tp_1');
  await userEvent.type(champ, '@');
  await waitFor(() => expect(options()).toHaveLength(2));
  await userEvent.keyboard('{ArrowDown}{Tab}');
  expect(champ.value).toBe('@src/mapper.ts ');
  await userEvent.type(champ, '@zz');
  expect(document.querySelector('[data-node="cv.mention.vide"]')?.textContent).toBe(
    'Aucun fichier ne correspond.',
  );
  await userEvent.keyboard('{Escape}');
  expect(document.querySelector('[data-node="cv.mention"]')).toBeNull();
  await userEvent.clear(champ);
  await userEvent.type(champ, '@');
  await waitFor(() => expect(options()).toHaveLength(2));
  await userEvent.pointer({ keys: '[MouseLeft]', target: screen.getByText('@src/app.ts') });
  expect(champ.value).toBe('@src/app.ts ');
});

test('un arbre tronqué : la liste dit qu’elle est incomplète', async () => {
  const { champ } = monter('tp_1', arbre(true));
  await userEvent.type(champ, '@');
  await waitFor(() =>
    expect(document.querySelector('[data-node="cv.mention.tronque"]')?.textContent).toContain(
      'Liste incomplète',
    ),
  );
});

test('sans sujet (discussion de serveur) : pas de menu @, aucune lecture', async () => {
  const { champ, lectures } = monter(undefined);
  await userEvent.type(champ, 'voir @');
  expect(document.querySelector('[data-node="cv.mention"]')).toBeNull();
  expect(lectures()).toHaveLength(0);
});
