import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { monotonicFactory } from 'ulid';
import type { Workspace, WorkspaceConsignes } from '../../shared/model.js';
import { slugify } from '../../shared/slug.js';
import type { Db } from '../db.js';
import { AidHttpError } from '../errors.js';
import { inspectRepo, localBranchExists, NotARepo, remoteBranchExists } from '../git/inspect.js';
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

const readOrNull = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : null);

/** Consignes d'un dépôt, en lecture seule : A-I-D n'écrit jamais ces fichiers. */
export function readConsignes(root: string, kernelDir: string): WorkspaceConsignes {
  const claude = readOrNull(join(root, 'CLAUDE.md'));
  const agents = readOrNull(join(root, 'AGENTS.md'));
  const start = /<!--\s*agentkit:start\s+(\S+)\s*-->/;
  const block = start.exec(claude ?? '') ?? start.exec(agents ?? '');
  return {
    claudeMd: claude !== null,
    agentsMd: agents !== null,
    blockVersion: block?.[1] ?? null,
    kernelVersion: readOrNull(join(kernelDir, 'VERSION'))?.trim() || null,
  };
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
    // Sans origin, le projet est purement local : les sujets partent de la branche locale (par défaut la courante).
    const base = body.baseBranch ?? (repo.hasOrigin ? repo.baseBranch : repo.currentBranch);
    if (!base) throw new AidHttpError(422, 'branche de base introuvable : la préciser');
    if (repo.hasOrigin && !(await remoteBranchExists(repo.root, base))) {
      throw new AidHttpError(
        422,
        `origin/${base} est introuvable : faire un git fetch ou corriger la base`,
      );
    }
    if (!repo.hasOrigin && !(await localBranchExists(repo.root, base))) {
      throw new AidHttpError(422, `la branche ${base} est introuvable dans le dépôt`);
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
      remote: repo.hasOrigin ? 'origin' : null,
      baseBranch: base,
      worktreesDir: join(deps.paths.worktrees, name),
      createdAt: new Date().toISOString(),
    };
    deps.db
      .prepare(
        'INSERT INTO workspaces (id, name, root, base_branch, worktrees_dir, created_at, remote) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(ws.id, ws.name, ws.root, ws.baseBranch, ws.worktreesDir, ws.createdAt, ws.remote);
    const warnings = wslWarnings(repo.root, (deps.procVersion ?? readProcVersion)());
    if (!ws.remote) {
      warnings.push(`dépôt sans remote origin : les sujets partiront de la branche locale ${base}`);
    }
    return reply.code(201).send({ ...ws, warnings });
  });

  app.get('/api/workspaces/:id/consignes', async (req) => {
    const { id } = req.params as { id: string };
    const ws = deps.db.prepare('SELECT root FROM workspaces WHERE id = ?').get(id) as
      { root: string } | undefined;
    if (!ws) throw new AidHttpError(404, `projet ${id} inconnu`);
    return readConsignes(ws.root, join(homedir(), '.agent-kernel'));
  });

  // Retirer un projet oublie son enregistrement et ses sujets archivés ; ni le dépôt ni le journal ne sont touchés.
  app.delete('/api/workspaces/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = deps.db;
    if (!db.prepare('SELECT 1 FROM workspaces WHERE id = ?').get(id)) {
      throw new AidHttpError(404, `projet ${id} inconnu`);
    }
    const open = db
      .prepare("SELECT count(*) AS n FROM topics WHERE workspace_id = ? AND state != 'archived'")
      .get(id) as { n: number };
    if (open.n > 0) {
      throw new AidHttpError(
        409,
        `${open.n} sujet${open.n > 1 ? 's' : ''} ouvert${open.n > 1 ? 's' : ''} : les archiver avant de retirer le projet`,
      );
    }
    const runs =
      'SELECT r.id FROM runs r JOIN topics t ON t.id = r.topic_id WHERE t.workspace_id = ?';
    const live = db
      .prepare(
        `SELECT count(*) AS n FROM agents WHERE run_id IN (${runs}) AND status NOT IN ('done', 'error', 'stopped')`,
      )
      .get(id) as { n: number };
    if (live.n > 0) throw new AidHttpError(409, 'un agent tourne encore pour ce projet');
    db.transaction(() => {
      db.prepare(`DELETE FROM agents WHERE run_id IN (${runs})`).run(id);
      db.prepare(
        'DELETE FROM runs WHERE topic_id IN (SELECT id FROM topics WHERE workspace_id = ?)',
      ).run(id);
      db.prepare('DELETE FROM topics WHERE workspace_id = ?').run(id);
      db.prepare('DELETE FROM actions WHERE workspace_id = ?').run(id);
      db.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
    })();
    return reply.code(204).send();
  });
}
