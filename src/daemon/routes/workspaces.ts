import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { monotonicFactory } from 'ulid';
import type { Workspace } from '../../shared/model.js';
import { slugify } from '../../shared/slug.js';
import type { Db } from '../db.js';
import { AidHttpError } from '../errors.js';
import { inspectRepo, NotARepo, remoteBranchExists } from '../git/inspect.js';
import type { AidPaths } from '../paths.js';

const ulid = monotonicFactory();

const Body = Type.Object(
  { path: Type.String({ minLength: 1 }), baseBranch: Type.Optional(Type.String({ minLength: 1 })) },
  { additionalProperties: false },
);

export function readProcVersion(): string | null {
  return existsSync('/proc/version') ? readFileSync('/proc/version', 'utf8') : null;
}

export function wslWarnings(root: string, procVersion: string | null): string[] {
  return procVersion?.toLowerCase().includes('microsoft') && root.startsWith('/mnt/')
    ? ['repo sous /mnt : performances WSL2 dégradées']
    : [];
}

function uniqueName(db: Db, wanted: string): string {
  let name = wanted;
  for (let i = 2; db.prepare('SELECT 1 FROM workspaces WHERE name = ?').get(name); i++) {
    name = `${wanted}-${i}`;
  }
  return name;
}

export function registerWorkspaceRoutes(
  app: FastifyInstance,
  deps: { db: Db; paths: AidPaths; procVersion?: () => string | null },
): void {
  app.post('/api/workspaces', { schema: { body: Body } }, async (req, reply) => {
    const body = req.body as { path: string; baseBranch?: string };
    let repo;
    try {
      repo = await inspectRepo(body.path);
    } catch (err) {
      if (err instanceof NotARepo) throw new AidHttpError(422, err.message);
      throw err;
    }
    if (repo.isLinkedWorktree) {
      throw new AidHttpError(
        422,
        `${repo.root} est un worktree lié : enregistrer le dépôt principal`,
      );
    }
    if (!repo.hasOrigin) throw new AidHttpError(422, "le dépôt n'a pas de remote origin");
    const base = body.baseBranch ?? repo.baseBranch;
    if (!base) throw new AidHttpError(422, 'branche de base introuvable : la préciser');
    if (!(await remoteBranchExists(repo.root, base))) {
      throw new AidHttpError(
        422,
        `origin/${base} est introuvable : faire un git fetch ou corriger la base`,
      );
    }
    if (deps.db.prepare('SELECT 1 FROM workspaces WHERE root = ?').get(repo.root)) {
      throw new AidHttpError(409, `${repo.root} est déjà enregistré`);
    }
    let wanted: string;
    try {
      wanted = slugify(basename(repo.root));
    } catch {
      wanted = 'depot';
    }
    const name = uniqueName(deps.db, wanted);
    const ws: Workspace = {
      id: `ws_${ulid()}`,
      name,
      root: repo.root,
      baseBranch: base,
      worktreesDir: join(deps.paths.worktrees, name),
      createdAt: new Date().toISOString(),
    };
    deps.db
      .prepare('INSERT INTO workspaces VALUES (?, ?, ?, ?, ?, ?)')
      .run(ws.id, ws.name, ws.root, ws.baseBranch, ws.worktreesDir, ws.createdAt);
    const warnings = wslWarnings(repo.root, (deps.procVersion ?? readProcVersion)());
    return reply.code(201).send({ ...ws, warnings });
  });
}
