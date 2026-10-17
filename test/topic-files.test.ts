import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { FileNode, FilesResponse } from '../src/shared/files.js';
import { sh } from './helpers/git.js';
import { type Ctx, makeTopic, setupWorkspace } from './helpers/topics.js';

let c: Ctx;
afterEach(async () => {
  await c?.t.d.stop();
});

const getTree = async (topicId: string, query = '') =>
  c.t.d.app.inject({ url: `/api/topics/${topicId}/files${query}`, headers: c.t.headers });

const getContent = async (topicId: string, path: string) =>
  c.t.d.app.inject({
    url: `/api/topics/${topicId}/files/content?path=${encodeURIComponent(path)}`,
    headers: c.t.headers,
  });

function findNode(nodes: FileNode[], path: string): FileNode | undefined {
  for (const n of nodes) {
    if (n.path === path) return n;
    if (n.entries) {
      const found = findNode(n.entries, path);
      if (found) return found;
    }
  }
  return undefined;
}

test('GET /files : arbre + statut git fusionnés (défaut « tout »)', async () => {
  c = await setupWorkspace();
  const un = await makeTopic(c, 'Premier');
  mkdirSync(join(un.wt, 'src'));
  writeFileSync(join(un.wt, 'src', 'ajoute.ts'), 'export const x = 1;\n');
  sh(un.wt, 'add', 'src/ajoute.ts');
  writeFileSync(join(un.wt, 'README.md'), '# modifié\n');
  writeFileSync(join(un.wt, 'non-suivi.txt'), 'nouveau\n');

  const r = await getTree(un.topicId);
  expect(r.statusCode).toBe(200);
  const body = r.json<FilesResponse>();
  expect(body.truncated).toBe(false);
  expect(findNode(body.tree, 'README.md')).toMatchObject({ kind: 'file', status: 'M' });
  expect(findNode(body.tree, 'src/ajoute.ts')).toMatchObject({ kind: 'file', status: 'A' });
  expect(findNode(body.tree, 'non-suivi.txt')).toMatchObject({ kind: 'file', status: 'U' });
  expect(findNode(body.tree, 'src')).toMatchObject({ kind: 'dir', status: '•' });
  expect(body.modified).toBe(3);
  expect(body.total).toBeGreaterThanOrEqual(3);
});

test('GET /files?scope=modifies : ne renvoie que les chemins présents dans le statut', async () => {
  c = await setupWorkspace();
  const un = await makeTopic(c, 'Premier');
  writeFileSync(join(un.wt, 'README.md'), '# modifié\n');

  const r = await getTree(un.topicId, '?scope=modifies');
  expect(r.statusCode).toBe(200);
  const body = r.json<FilesResponse>();
  const paths = (nodes: FileNode[]): string[] =>
    nodes.flatMap((n) => [n.path, ...(n.entries ? paths(n.entries) : [])]);
  expect(paths(body.tree)).toEqual(['README.md']);
});

test('GET /files/content : contenu brut d’un fichier', async () => {
  c = await setupWorkspace();
  const un = await makeTopic(c, 'Premier');
  const r = await getContent(un.topicId, 'README.md');
  expect(r.statusCode).toBe(200);
  expect(r.json<{ content: string }>().content).toBe('# dépôt de test\n');
});

test('GET /files/content : traversée ../ rejetée (422)', async () => {
  c = await setupWorkspace();
  const un = await makeTopic(c, 'Premier');
  // un chemin relatif vrai, calculé par node, vers un fichier réel hors du worktree (le
  // dépôt bare origin) — pas un nombre de « .. » devinés qui dépendrait de la profondeur du
  // tmpdir. Les deux côtés en realpath : sinon le symlink macOS /var → /private/var décale
  // le compte de « .. » d'un niveau (même piège que D25/11.5).
  const dehors = relative(realpathSync(un.wt), join(realpathSync(c.origin), 'HEAD'));
  const r = await getContent(un.topicId, dehors);
  expect(r.statusCode).toBe(422);
});

test('GET /files/content : fichier binaire rejeté (422)', async () => {
  c = await setupWorkspace();
  const un = await makeTopic(c, 'Premier');
  writeFileSync(join(un.wt, 'image.bin'), Buffer.from([0, 1, 2, 3, 0, 4]));
  const r = await getContent(un.topicId, 'image.bin');
  expect(r.statusCode).toBe(422);
});

test('GET /files/content : fichier supprimé pendant la lecture → introuvable (404)', async () => {
  c = await setupWorkspace();
  const un = await makeTopic(c, 'Premier');
  writeFileSync(join(un.wt, 'ephemere.txt'), 'bientôt supprimé\n');
  rmSync(join(un.wt, 'ephemere.txt'));
  const r = await getContent(un.topicId, 'ephemere.txt');
  expect(r.statusCode).toBe(404);
});
