// @vitest-environment jsdom
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test } from 'vitest';
import { OngletFichiers } from '../../web/src/ecrans/OngletFichiers.js';
import { json, setup, snapshot } from './helpers.js';

afterEach(cleanup);

// 11.9 (écran 3.5, D31) : numéros de ligne + police monospace, bascule aperçu/source pour un
// .md seulement, états vide (fichier vide) et erreur (réutilise le 422 de 11.7, déjà testé
// dans visionneuse-markdown.test.tsx).

const arbre = (entries: Array<{ name: string; path: string }>) => ({
  tree: entries.map((e) => ({ name: e.name, path: e.path, kind: 'file' as const, status: '' })),
  total: entries.length,
  modified: 0,
  truncated: false,
});

test('un .md : bascule aperçu/source, numéros de ligne en source', async () => {
  setup(<OngletFichiers topicId="tp_1" activeAgentId={null} />, snapshot(), '/', {
    'GET /api/topics/tp_1/files?scope=tout': json(
      200,
      arbre([{ name: 'README.md', path: 'README.md' }]),
    ),
    'GET /api/topics/tp_1/files/content?path=README.md': json(200, {
      content: '# Titre\n\ntexte',
    }),
  });
  await userEvent.click(await screen.findByText('README.md'));
  await screen.findByRole('heading', { level: 1, name: 'Titre' });
  const bascule = screen.getByRole('group', { name: 'Mode d’affichage' });
  expect(bascule.querySelector('.segment.est-actif')?.textContent).toBe('Aperçu');
  await userEvent.click(screen.getByRole('button', { name: 'Source' }));
  await waitFor(() => expect(screen.queryByRole('heading', { level: 1 })).toBeNull());
  const region = screen.getByRole('region', { name: 'Source du fichier' });
  const numeros = region.querySelectorAll('.source-numero');
  expect(Array.from(numeros).map((n) => n.textContent)).toEqual(['1', '2', '3']);
  const textes = region.querySelectorAll('.source-texte');
  expect(Array.from(textes).map((n) => n.textContent)).toEqual(['# Titre', '', 'texte']);
  expect(bascule.querySelector('.segment.est-actif')?.textContent).toBe('Source');
});

test('un fichier non .md : source directe, sans bascule', async () => {
  setup(<OngletFichiers topicId="tp_1" activeAgentId={null} />, snapshot(), '/', {
    'GET /api/topics/tp_1/files?scope=tout': json(
      200,
      arbre([{ name: 'index.ts', path: 'index.ts' }]),
    ),
    'GET /api/topics/tp_1/files/content?path=index.ts': json(200, {
      content: 'const a = 1;\n',
    }),
  });
  await userEvent.click(await screen.findByText('index.ts'));
  const region = await screen.findByRole('region', { name: 'Source du fichier' });
  expect(screen.queryByRole('group', { name: 'Mode d’affichage' })).toBeNull();
  // Un seul numéro de ligne : la dernière ligne vide après le \n final n’est pas comptée.
  expect(Array.from(region.querySelectorAll('.source-numero')).map((n) => n.textContent)).toEqual([
    '1',
  ]);
});

test('fichier vide : message dédié, ni aperçu ni source', async () => {
  setup(<OngletFichiers topicId="tp_1" activeAgentId={null} />, snapshot(), '/', {
    'GET /api/topics/tp_1/files?scope=tout': json(
      200,
      arbre([{ name: 'vide.txt', path: 'vide.txt' }]),
    ),
    'GET /api/topics/tp_1/files/content?path=vide.txt': json(200, { content: '' }),
  });
  await userEvent.click(await screen.findByText('vide.txt'));
  expect(await screen.findByText('Fichier vide.')).toBeTruthy();
  expect(screen.getByText('vide.txt existe mais ne contient encore rien.')).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'Source du fichier' })).toBeNull();
});

test('erreur de lecture (binaire ou trop gros, 422 de 11.7) : message affiché, pas de source', async () => {
  setup(<OngletFichiers topicId="tp_1" activeAgentId={null} />, snapshot(), '/', {
    'GET /api/topics/tp_1/files?scope=tout': json(
      200,
      arbre([{ name: 'bin.tgz', path: 'bin.tgz' }]),
    ),
    'GET /api/topics/tp_1/files/content?path=bin.tgz': () =>
      new Response(JSON.stringify({ error: 'fichier binaire ou trop volumineux' }), {
        status: 422,
      }),
  });
  await userEvent.click(await screen.findByText('bin.tgz'));
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'Source du fichier' })).toBeNull();
});
