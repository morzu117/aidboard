// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test } from 'vitest';
import { OngletFichiers } from '../../web/src/ecrans/OngletFichiers.js';
import { renderMarkdown } from '../../web/src/ui/markdown.js';
import { json, setup, snapshot } from './helpers.js';

afterEach(cleanup);

// renderMarkdown (D30) : marked en tokenizer, jamais de dangerouslySetInnerHTML.

test('renderMarkdown : titres h2 → sommaire, dans l’ordre d’apparition', () => {
  const { headings } = renderMarkdown('# Titre\n\n## Un\n\ntexte\n\n## Deux\n');
  expect(headings).toEqual([
    { id: 'un', text: 'Un' },
    { id: 'deux', text: 'Deux' },
  ]);
});

test('renderMarkdown : case à cocher de liste de tâches, cochée ou non', () => {
  const { body } = renderMarkdown('- [x] fait\n- [ ] pas fait\n');
  const { container } = render(<>{body}</>);
  const cases = container.querySelectorAll('.md-case');
  expect(cases).toHaveLength(2);
  expect(cases[0]?.className).toContain('md-case--faite');
  expect(cases[0]?.textContent).toBe('✓');
  expect(cases[1]?.className).not.toContain('md-case--faite');
  expect(cases[1]?.textContent).toBe('');
});

test('renderMarkdown : bloc de code avec bouton copier, et tableau', () => {
  const { body } = renderMarkdown('```ts\nconst a = 1;\n```\n\n| A | B |\n| - | - |\n| 1 | 2 |\n');
  const { container } = render(<>{body}</>);
  expect(container.querySelector('.md-pre')?.textContent).toBe('const a = 1;');
  expect(container.querySelector('[data-action="md.copier-code"]')?.textContent).toBe('Copier');
  const cellules = container.querySelectorAll('.md-cellule');
  expect(Array.from(cellules).map((c) => c.textContent)).toEqual(['A', 'B', '1', '2']);
});

test('renderMarkdown : lien http cliquable, lien relatif rendu inerte, jamais de HTML brut injecté', () => {
  const { body } = renderMarkdown(
    '[externe](https://exemple.test) et [relatif](./autre.md) et <script>alert(1)</script>\n',
  );
  const { container } = render(<>{body}</>);
  const lien = container.querySelector('a.md-lien');
  expect(lien?.getAttribute('href')).toBe('https://exemple.test');
  expect(lien?.getAttribute('target')).toBe('_blank');
  const liens = container.querySelectorAll('.md-lien');
  expect(liens).toHaveLength(2);
  expect(liens[1]?.tagName).toBe('SPAN');
  expect(liens[1]?.textContent).toBe('relatif');
  // Le HTML brut est affiché comme texte, jamais interprété (pas de <script> réel dans le DOM).
  expect(container.querySelector('script')).toBeNull();
  expect(container.textContent).toContain('<script>alert(1)</script>');
});

// OngletFichiers (11.8, écran 3.4) : câblage explorateur ↔ visionneuse.

test('explorateur : portée Tout/Modifiés, filtre, et état vide', async () => {
  setup(<OngletFichiers topicId="tp_1" activeAgentId={null} />, snapshot(), '/', {
    'GET /api/topics/tp_1/files?scope=tout': json(200, {
      tree: [
        { name: 'README.md', path: 'README.md', kind: 'file', status: '' },
        {
          name: 'src',
          path: 'src',
          kind: 'dir',
          status: 'M',
          entries: [{ name: 'index.ts', path: 'src/index.ts', kind: 'file', status: 'M' }],
        },
      ],
      total: 2,
      modified: 1,
      truncated: false,
    }),
    'GET /api/topics/tp_1/files?scope=modifies': json(200, {
      tree: [
        {
          name: 'src',
          path: 'src',
          kind: 'dir',
          status: 'M',
          entries: [{ name: 'index.ts', path: 'src/index.ts', kind: 'file', status: 'M' }],
        },
      ],
      total: 1,
      modified: 1,
      truncated: false,
    }),
  });
  await screen.findByText('README.md');
  await userEvent.click(screen.getByText('Modifiés · 1'));
  await waitFor(() => expect(screen.queryByText('README.md')).toBeNull());
  await userEvent.click(screen.getByText('src'));
  expect(screen.getByText('index.ts')).toBeTruthy();
  await userEvent.type(screen.getByLabelText('Filtrer les fichiers'), 'zzz');
  expect(await screen.findByText('Aucun fichier modifié.')).toBeTruthy();
});

test('visionneuse : un .md s’affiche en aperçu avec sommaire, un autre fichier en source brute', async () => {
  setup(<OngletFichiers topicId="tp_1" activeAgentId={null} />, snapshot(), '/', {
    'GET /api/topics/tp_1/files?scope=tout': json(200, {
      tree: [
        { name: 'README.md', path: 'README.md', kind: 'file', status: '' },
        { name: 'index.ts', path: 'index.ts', kind: 'file', status: '' },
      ],
      total: 2,
      modified: 0,
      truncated: false,
    }),
    'GET /api/topics/tp_1/files/content?path=README.md': json(200, {
      content: '## Section\n\ntexte',
    }),
    'GET /api/topics/tp_1/files/content?path=index.ts': json(200, {
      content: 'const a = 1;',
    }),
  });
  await userEvent.click(await screen.findByText('README.md'));
  expect(await screen.findByRole('heading', { level: 2, name: 'Section' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Section' }).getAttribute('href')).toBe('#section');
  await userEvent.click(screen.getByText('index.ts'));
  await waitFor(() =>
    expect(screen.queryByRole('heading', { level: 2, name: 'Section' })).toBeNull(),
  );
  expect(await screen.findByText('const a = 1;')).toBeTruthy();
});

test('mentionner à l’agent : insère le chemin via l’endpoint existant /api/agents/:id/input, désactivé sans agent actif', async () => {
  const h = setup(<OngletFichiers topicId="tp_1" activeAgentId="ag_1" />, snapshot(), '/', {
    'GET /api/topics/tp_1/files?scope=tout': json(200, {
      tree: [{ name: 'README.md', path: 'README.md', kind: 'file', status: '' }],
      total: 1,
      modified: 0,
      truncated: false,
    }),
    'GET /api/topics/tp_1/files/content?path=README.md': json(200, { content: 'texte' }),
    'POST /api/agents/ag_1/input': json(200, {}),
  });
  await userEvent.click(await screen.findByText('README.md'));
  const bouton = await screen.findByText('Mentionner à l’agent');
  expect(bouton.getAttribute('disabled')).toBeNull();
  await userEvent.click(bouton);
  await waitFor(() =>
    expect(h.calls.find((c) => c.url === '/api/agents/ag_1/input')?.body).toEqual({
      text: '@README.md ',
    }),
  );
});

test('mentionner à l’agent : désactivé quand aucun agent n’est actif', async () => {
  setup(<OngletFichiers topicId="tp_1" activeAgentId={null} />, snapshot(), '/', {
    'GET /api/topics/tp_1/files?scope=tout': json(200, {
      tree: [{ name: 'README.md', path: 'README.md', kind: 'file', status: '' }],
      total: 1,
      modified: 0,
      truncated: false,
    }),
    'GET /api/topics/tp_1/files/content?path=README.md': json(200, { content: 'texte' }),
  });
  await userEvent.click(await screen.findByText('README.md'));
  const bouton = await screen.findByText('Mentionner à l’agent');
  expect(bouton.getAttribute('disabled')).not.toBeNull();
});
