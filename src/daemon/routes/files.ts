import { existsSync, readFileSync, realpathSync, statSync, type Stats } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { FileNode, FileStatus, FilesResponse } from '../../shared/files.js';
import type { Db } from '../db.js';
import { AidHttpError } from '../errors.js';
import { gitFileStatuses } from '../git/inspect.js';

const MAX_ENTRIES = 1000;
const MAX_CONTENT_BYTES = 1024 * 1024;

const TreeQuery = Type.Object(
  {
    scope: Type.Optional(Type.Union([Type.Literal('tout'), Type.Literal('modifies')])),
    path: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
const ContentQuery = Type.Object(
  { path: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

// Résout `relPath` sous `worktree` et vérifie (sur le réel, symlinks compris) qu'il n'en
// sort pas — même garde que `fs.ts` sous $HOME, appliquée ici au worktree (D29).
function resolveUnderWorktree(worktree: string, relPath: string): string {
  const root = realpathSync(worktree);
  const target = join(root, relPath);
  let real: string;
  try {
    real = realpathSync(target);
  } catch {
    throw new AidHttpError(404, `${relPath} est introuvable`);
  }
  if (real !== root && !real.startsWith(root + sep)) {
    throw new AidHttpError(422, `${relPath} sort du worktree`);
  }
  return real;
}

// Entre la résolution du chemin et cette lecture, le fichier a pu disparaître ou être
// renommé (race du worktree) : traité comme introuvable, pas comme une erreur serveur.
function statOrNotFound(path: string, relPath: string): Stats {
  try {
    return statSync(path);
  } catch {
    throw new AidHttpError(404, `${relPath} est introuvable`);
  }
}

function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0);
}

type Budget = { count: number; truncated: boolean };

async function walk(
  dir: string,
  relBase: string,
  statuses: Map<string, FileStatus>,
  budget: Budget,
): Promise<FileNode[]> {
  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const sorted = dirents
    .filter((d) => d.name !== '.git')
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const nodes: FileNode[] = [];
  for (const d of sorted) {
    if (budget.truncated) break;
    if (budget.count >= MAX_ENTRIES) {
      budget.truncated = true;
      break;
    }
    budget.count += 1;
    const path = relBase ? `${relBase}/${d.name}` : d.name;
    if (d.isDirectory()) {
      const entries = await walk(join(dir, d.name), path, statuses, budget);
      const status: FileStatus = entries.some((e) => e.status !== '') ? '•' : '';
      nodes.push({ name: d.name, path, kind: 'dir', status, entries });
    } else if (d.isFile()) {
      nodes.push({ name: d.name, path, kind: 'file', status: statuses.get(path) ?? '' });
    }
  }
  return nodes;
}

function countFiles(nodes: FileNode[]): { total: number; modified: number } {
  let total = 0;
  let modified = 0;
  for (const n of nodes) {
    if (n.kind === 'file') {
      total += 1;
      if (n.status !== '') modified += 1;
    } else {
      const c = countFiles(n.entries ?? []);
      total += c.total;
      modified += c.modified;
    }
  }
  return { total, modified };
}

// La portée « modifiés » filtre côté serveur sur les chemins présents dans le statut (D29) :
// un fichier sans statut disparaît, un dossier disparaît s'il ne garde aucun descendant.
function pruneToModified(nodes: FileNode[]): FileNode[] {
  const kept: FileNode[] = [];
  for (const n of nodes) {
    if (n.kind === 'file') {
      if (n.status !== '') kept.push(n);
    } else {
      const entries = pruneToModified(n.entries ?? []);
      if (entries.length > 0) kept.push({ ...n, entries });
    }
  }
  return kept;
}

export function registerFileRoutes(app: FastifyInstance, deps: { db: Db }): void {
  app.get('/api/topics/:id/files', { schema: { querystring: TreeQuery } }, async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { scope?: 'tout' | 'modifies'; path?: string };
    const row = deps.db.prepare('SELECT worktree FROM topics WHERE id = ?').get(id) as
      { worktree: string } | undefined;
    if (!row) throw new AidHttpError(404, 'sujet inconnu');
    if (!existsSync(row.worktree)) throw new AidHttpError(409, 'worktree introuvable');
    const rel = q.path ?? '';
    const root = resolveUnderWorktree(row.worktree, rel);
    if (!statOrNotFound(root, rel).isDirectory()) {
      throw new AidHttpError(422, `${rel} n'est pas un dossier`);
    }
    const statuses = await gitFileStatuses(row.worktree);
    const budget: Budget = { count: 0, truncated: false };
    const tree = await walk(root, rel, statuses, budget);
    const { total, modified } = countFiles(tree);
    return {
      tree: q.scope === 'modifies' ? pruneToModified(tree) : tree,
      total,
      modified,
      truncated: budget.truncated,
    } satisfies FilesResponse;
  });

  app.get(
    '/api/topics/:id/files/content',
    { schema: { querystring: ContentQuery } },
    async (req) => {
      const { id } = req.params as { id: string };
      const q = req.query as { path: string };
      const row = deps.db.prepare('SELECT worktree FROM topics WHERE id = ?').get(id) as
        { worktree: string } | undefined;
      if (!row) throw new AidHttpError(404, 'sujet inconnu');
      if (!existsSync(row.worktree)) throw new AidHttpError(409, 'worktree introuvable');
      const full = resolveUnderWorktree(row.worktree, q.path);
      const st = statOrNotFound(full, q.path);
      if (!st.isFile()) throw new AidHttpError(404, `${q.path} est introuvable`);
      if (st.size > MAX_CONTENT_BYTES) throw new AidHttpError(422, `${q.path} est trop volumineux`);
      const buf = readFileSync(full);
      if (isBinary(buf)) throw new AidHttpError(422, `${q.path} est un fichier binaire`);
      return { content: buf.toString('utf8') };
    },
  );
}
