import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { monotonicFactory } from 'ulid';
import { isValidSlug, slugify } from '../../shared/slug.js';
import { type ActionContext, scriptEnv, startAction } from '../actions/service.js';
import { editorCommand, openInEditor } from '../actions/editor.js';
import { findAssetDir } from '../assets.js';
import type { AidConfig } from '../config.js';
import type { Db } from '../db.js';
import { AidHttpError } from '../errors.js';
import { git } from '../git/exec.js';
import { gitCommitDetail, gitLiveInfo, gitLog, hasUncommittedChanges } from '../git/inspect.js';
import type { StructuralService } from '../structural/service.js';
import type { Indexer } from '../topics/index.js';

const ulid = monotonicFactory();
const FIVE_MIN = 5 * 60_000;
const TWO_MIN = 2 * 60_000;
const LIVE = ['starting', 'working', 'needs_input', 'idle'];

// Actions d'un sujet connues en v0.1 et au chantier 06
export const TOPIC_ACTIONS = [
  'topic.cleanup',
  'editor.open',
  'topic.setup-ignorer',
  'topic.sync',
  'topic.sync-continuer',
  'topic.sync-annuler',
  'topic.test',
  'topic.pr',
  'pr.rafraichir',
  'topic.merge',
  'archive.oublier-stash',
  'git.fetch',
  'git.pousser',
] as const;

const CreateBody = Type.Object(
  {
    workspaceId: Type.String({ minLength: 1 }),
    title: Type.String({ minLength: 1, maxLength: 200 }),
    type: Type.Unsafe<'feat' | 'fix' | 'chore' | 'spike'>({
      type: 'string',
      enum: ['feat', 'fix', 'chore', 'spike'],
    }),
    slug: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export interface TopicRouteDeps {
  db: Db;
  engine: StructuralService;
  config: AidConfig;
  actions: ActionContext;
  indexer: Indexer;
}

interface TopicRow {
  id: string;
  workspace_id: string;
  branch: string;
  base: string;
  worktree: string;
  state: string;
  pr_number: number | null;
  stash_ref: string | null;
}

interface WorkspaceRow {
  id: string;
  name: string;
  root: string;
  base_branch: string;
  worktrees_dir: string;
  remote: string | null;
}

export function registerTopicRoutes(app: FastifyInstance, deps: TopicRouteDeps): void {
  const scripts = findAssetDir('scripts/git', 'topic-create.sh');

  app.post('/api/topics', { schema: { body: CreateBody } }, async (req, reply) => {
    const body = req.body as { workspaceId: string; title: string; type: string; slug?: string };
    const ws = deps.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(body.workspaceId) as
      WorkspaceRow | undefined;
    if (!ws) throw new AidHttpError(404, 'workspace inconnu');
    let slug: string;
    if (body.slug !== undefined) {
      if (!isValidSlug(body.slug)) throw new AidHttpError(422, `slug invalide : ${body.slug}`);
      slug = body.slug;
    } else {
      try {
        slug = slugify(body.title);
      } catch (err) {
        throw new AidHttpError(422, (err as Error).message);
      }
    }
    if (
      deps.db.prepare('SELECT 1 FROM topics WHERE workspace_id = ? AND slug = ?').get(ws.id, slug)
    ) {
      throw new AidHttpError(409, `un sujet « ${slug} » existe déjà dans ce workspace`);
    }
    const topicId = `tp_${ulid()}`;
    const branch = `${body.type}/${slug}`;
    const worktree = join(ws.worktrees_dir, slug);
    // D6 : on n'indexe que si le dépôt principal a déjà adopté l'index
    const indexed = deps.engine.detect(ws.root);
    const now = new Date().toISOString();

    // D15 : le sujet existe en `draft` dès la requête, avant que le script ne tourne.
    deps.actions.store.append(
      {
        source: 'daemon',
        type: 'topic.state',
        workspaceId: ws.id,
        topicId,
        data: { state: 'draft', indexState: indexed ? 'indexing' : 'disabled' },
      },
      (tx) => {
        tx.prepare(
          'INSERT INTO topics VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, NULL, NULL)',
        ).run(
          topicId,
          ws.id,
          slug,
          body.title,
          body.type,
          branch,
          ws.base_branch,
          worktree,
          'draft',
          indexed ? 'indexing' : 'disabled',
          now,
          now,
        );
        tx.prepare("INSERT INTO runs VALUES (?, ?, 'standard', 'open', ?)").run(
          `run_${ulid()}`,
          topicId,
          now,
        );
      },
    );

    const { actionId } = startAction(deps.actions, {
      workspaceId: ws.id,
      topicId,
      action: 'topic.create',
      script: join(scripts, 'topic-create.sh'),
      cwd: ws.root,
      timeoutMs: FIVE_MIN,
      data: { slug, branch },
      env: scriptEnv(process.env, deps.config.env.strip, {
        AID_REPO_ROOT: ws.root,
        AID_TOPIC: topicId,
        AID_SLUG: slug,
        AID_BRANCH: branch,
        AID_BASE: ws.base_branch,
        AID_REMOTE: ws.remote ?? '',
        AID_WORKTREE: worktree,
      }),
      afterSuccess: () => {
        deps.actions.store.append({
          source: 'daemon',
          type: 'topic.state',
          workspaceId: ws.id,
          topicId,
          data: { state: 'active' },
        });
        if (indexed) deps.indexer.start({ id: topicId, workspaceId: ws.id, worktree });
        return { topicId };
      },
      // Le brouillon n'a rien créé sur disque : un échec du script le fait disparaître,
      // le slug redevient immédiatement utilisable (même suppression que topic.setup-ignorer).
      afterFailure: () => {
        deps.db.transaction(() => {
          deps.db.prepare('DELETE FROM runs WHERE topic_id = ?').run(topicId);
          deps.db.prepare('DELETE FROM topics WHERE id = ?').run(topicId);
        })();
      },
    });
    return reply.code(202).send({ actionId, slug, branch, topicId });
  });

  // Chronologie de l'écran archive (06.10) : aucun journal par sujet n'existait encore.
  // Le sujet est renvoyé en plus des événements : /api/state exclut les archivés par défaut,
  // donc l'écran archive n'a autrement aucun moyen de lire son titre/branche/stash_ref.
  app.get('/api/topics/:id/events', async (req) => {
    const { id } = req.params as { id: string };
    const row = deps.db.prepare('SELECT * FROM topics WHERE id = ?').get(id) as
      | {
          id: string;
          workspace_id: string;
          slug: string;
          title: string;
          branch: string;
          base: string;
          worktree: string;
          state: string;
          stash_ref: string | null;
          created_at: string;
          updated_at: string;
        }
      | undefined;
    if (!row) throw new AidHttpError(404, 'sujet inconnu');
    return {
      topic: {
        id: row.id,
        workspaceId: row.workspace_id,
        slug: row.slug,
        title: row.title,
        branch: row.branch,
        base: row.base,
        worktree: row.worktree,
        state: row.state,
        stashRef: row.stash_ref,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
      events: deps.actions.store.since(null, { topicId: id }),
    };
  });

  // 11.2/11.3/11.4 : commits bruts (D24) — géométrie du graphe laissée au client. `live`
  // alimente la bannière de situation (même passage, D16/D28 : pas un second appel git).
  app.get('/api/topics/:id/git/log', async (req) => {
    const { id } = req.params as { id: string };
    const row = deps.db.prepare('SELECT worktree, base FROM topics WHERE id = ?').get(id) as
      { worktree: string; base: string } | undefined;
    if (!row) throw new AidHttpError(404, 'sujet inconnu');
    if (!existsSync(row.worktree)) throw new AidHttpError(409, 'worktree introuvable');
    const [commits, dirty, live] = await Promise.all([
      gitLog(row.worktree, row.base),
      hasUncommittedChanges(row.worktree),
      gitLiveInfo(row.worktree, row.base),
    ]);
    return { commits, dirty, live };
  });

  // 11.3 : panneau de détail — un commit à la fois, jamais embarqué dans la liste (coûteux).
  app.get('/api/topics/:id/git/commits/:hash', async (req) => {
    const { id, hash } = req.params as { id: string; hash: string };
    const row = deps.db.prepare('SELECT worktree FROM topics WHERE id = ?').get(id) as
      { worktree: string } | undefined;
    if (!row) throw new AidHttpError(404, 'sujet inconnu');
    if (!existsSync(row.worktree)) throw new AidHttpError(409, 'worktree introuvable');
    const commit = await gitCommitDetail(row.worktree, hash);
    if (!commit) throw new AidHttpError(404, 'commit inconnu');
    return commit;
  });

  app.post('/api/topics/:id/actions/:actionId', async (req, reply) => {
    const { id, actionId } = req.params as { id: string; actionId: string };
    if (!(TOPIC_ACTIONS as readonly string[]).includes(actionId)) {
      throw new AidHttpError(404, `action inconnue : ${actionId}`);
    }
    const topic = deps.db.prepare('SELECT * FROM topics WHERE id = ?').get(id) as
      TopicRow | undefined;
    if (!topic) throw new AidHttpError(404, 'sujet inconnu');
    const ws = deps.db
      .prepare('SELECT * FROM workspaces WHERE id = ?')
      .get(topic.workspace_id) as WorkspaceRow;

    if (actionId === 'editor.open') {
      if (!existsSync(topic.worktree)) throw new AidHttpError(409, 'worktree introuvable');
      const cmd = editorCommand(deps.config.editor);
      try {
        await openInEditor(cmd, topic.worktree);
      } catch (err) {
        throw new AidHttpError(
          422,
          `impossible de lancer l'éditeur (${cmd.join(' ')}) : ${(err as Error).message}. Régler « editor » dans ~/.aid/config.yaml.`,
        );
      }
      return reply.code(204).send();
    }

    if (actionId === 'topic.setup-ignorer') {
      if (topic.state !== 'draft') {
        throw new AidHttpError(409, 'ce sujet n’est plus en préparation');
      }
      deps.db.transaction(() => {
        deps.db.prepare('DELETE FROM runs WHERE topic_id = ?').run(id);
        deps.db.prepare('DELETE FROM topics WHERE id = ?').run(id);
      })();
      return reply.code(204).send();
    }

    if (
      actionId === 'topic.sync' ||
      actionId === 'topic.sync-continuer' ||
      actionId === 'topic.sync-annuler'
    ) {
      if (!existsSync(topic.worktree)) throw new AidHttpError(409, 'worktree introuvable');
      const extra: Record<string, string> = {};
      if (actionId === 'topic.sync-continuer') extra.AID_SYNC_CONTINUE = '1';
      if (actionId === 'topic.sync-annuler') extra.AID_SYNC_ABORT = '1';
      const { actionId: runId } = startAction(deps.actions, {
        workspaceId: ws.id,
        topicId: id,
        action: actionId,
        script: join(scripts, 'topic-sync.sh'),
        cwd: topic.worktree,
        timeoutMs: FIVE_MIN,
        env: scriptEnv(process.env, deps.config.env.strip, {
          AID_REPO_ROOT: ws.root,
          AID_BRANCH: topic.branch,
          AID_BASE: topic.base,
          AID_WORKTREE: topic.worktree,
          ...extra,
        }),
      });
      return reply.code(202).send({ actionId: runId });
    }

    if (actionId === 'topic.test') {
      if (!existsSync(topic.worktree)) throw new AidHttpError(409, 'worktree introuvable');
      const { actionId: runId } = startAction(deps.actions, {
        workspaceId: ws.id,
        topicId: id,
        action: 'topic.test',
        script: join(scripts, 'topic-test.sh'),
        cwd: topic.worktree,
        timeoutMs: FIVE_MIN,
        env: scriptEnv(process.env, deps.config.env.strip, {}),
      });
      return reply.code(202).send({ actionId: runId });
    }

    // D33 : même file que topic.sync (startAction sérialise déjà par workspace) — pas de
    // `git fetch`/`git push` direct depuis la route.
    if (actionId === 'git.fetch') {
      if (!existsSync(topic.worktree)) throw new AidHttpError(409, 'worktree introuvable');
      const { actionId: runId } = startAction(deps.actions, {
        workspaceId: ws.id,
        topicId: id,
        action: 'git.fetch',
        script: join(scripts, 'topic-fetch.sh'),
        cwd: topic.worktree,
        timeoutMs: TWO_MIN,
        env: scriptEnv(process.env, deps.config.env.strip, { AID_BASE: topic.base }),
      });
      return reply.code(202).send({ actionId: runId });
    }

    if (actionId === 'git.pousser') {
      if (!existsSync(topic.worktree)) throw new AidHttpError(409, 'worktree introuvable');
      const live = await gitLiveInfo(topic.worktree, topic.base);
      if (!live.aheadBehind || live.aheadBehind.ahead === 0) {
        throw new AidHttpError(422, 'rien à pousser : pas d’avance sur origin/' + topic.base);
      }
      const { actionId: runId } = startAction(deps.actions, {
        workspaceId: ws.id,
        topicId: id,
        action: 'git.pousser',
        script: join(scripts, 'topic-push.sh'),
        cwd: topic.worktree,
        timeoutMs: TWO_MIN,
        env: scriptEnv(process.env, deps.config.env.strip, { AID_BRANCH: topic.branch }),
      });
      return reply.code(202).send({ actionId: runId });
    }

    if (actionId === 'topic.pr') {
      if (!existsSync(topic.worktree)) throw new AidHttpError(409, 'worktree introuvable');
      const prBody = (req.body ?? {}) as { title?: string; body?: string };
      if (!prBody.title) throw new AidHttpError(422, 'titre de PR requis');
      const { actionId: runId } = startAction(deps.actions, {
        workspaceId: ws.id,
        topicId: id,
        action: 'topic.pr',
        script: join(scripts, 'topic-pr.sh'),
        cwd: topic.worktree,
        timeoutMs: TWO_MIN,
        env: scriptEnv(process.env, deps.config.env.strip, {
          AID_BRANCH: topic.branch,
          AID_BASE: topic.base,
          AID_PR_TITLE: prBody.title,
          AID_PR_BODY: prBody.body ?? '',
        }),
        afterSuccess: (out) => {
          const prNumber = typeof out.result.number === 'number' ? out.result.number : null;
          const prUrl = typeof out.result.url === 'string' ? out.result.url : null;
          deps.actions.store.append({
            source: 'daemon',
            type: 'topic.pr',
            workspaceId: ws.id,
            topicId: id,
            data: { prNumber, prUrl },
          });
        },
      });
      return reply.code(202).send({ actionId: runId });
    }

    if (actionId === 'pr.rafraichir') {
      if (topic.pr_number == null) throw new AidHttpError(409, 'aucune PR ouverte pour ce sujet');
      const { actionId: runId } = startAction(deps.actions, {
        workspaceId: ws.id,
        topicId: id,
        action: 'pr.rafraichir',
        script: join(scripts, 'topic-pr-refresh.sh'),
        cwd: topic.worktree,
        timeoutMs: TWO_MIN,
        env: scriptEnv(process.env, deps.config.env.strip, {
          AID_PR_NUMBER: String(topic.pr_number),
        }),
      });
      return reply.code(202).send({ actionId: runId });
    }

    if (actionId === 'topic.merge') {
      if (topic.pr_number == null) throw new AidHttpError(409, 'aucune PR ouverte pour ce sujet');
      // gh peut réussir côté GitHub avant que le script ne confirme (coupure réseau après
      // l'appel) : un second topic.merge sur un sujet déjà fusionné n'est pas une erreur
      // bloquante, juste un 409 propre plutôt qu'une tentative de refusion.
      if (topic.state === 'merged') {
        throw new AidHttpError(409, 'ce sujet est déjà fusionné');
      }
      const mergeBody = (req.body ?? {}) as {
        strategy?: 'squash' | 'merge' | 'rebase';
        message?: string;
        deleteBranch?: boolean;
        cleanupAfter?: boolean;
      };
      if (!mergeBody.strategy) throw new AidHttpError(422, 'stratégie de fusion requise');
      const { actionId: runId } = startAction(deps.actions, {
        workspaceId: ws.id,
        topicId: id,
        action: 'topic.merge',
        script: join(scripts, 'topic-merge.sh'),
        cwd: topic.worktree,
        timeoutMs: TWO_MIN,
        env: scriptEnv(process.env, deps.config.env.strip, {
          AID_PR_NUMBER: String(topic.pr_number),
          AID_MERGE_STRATEGY: mergeBody.strategy,
          ...(mergeBody.message && { AID_MERGE_MESSAGE: mergeBody.message }),
          ...(mergeBody.deleteBranch && { AID_MERGE_DELETE_BRANCH: '1' }),
        }),
        afterSuccess: () => {
          deps.actions.store.append({
            source: 'daemon',
            type: 'topic.state',
            workspaceId: ws.id,
            topicId: id,
            data: { state: 'merged' },
          });
          if (mergeBody.cleanupAfter) {
            startAction(deps.actions, {
              workspaceId: ws.id,
              topicId: id,
              action: 'topic.cleanup',
              script: join(scripts, 'topic-cleanup.sh'),
              cwd: existsSync(topic.worktree) ? topic.worktree : ws.root,
              timeoutMs: TWO_MIN,
              env: scriptEnv(process.env, deps.config.env.strip, {
                AID_REPO_ROOT: ws.root,
                AID_TOPIC: id,
                AID_SLUG: topic.worktree.split('/').at(-1) ?? '',
                AID_BRANCH: topic.branch,
                AID_BASE: topic.base,
                AID_WORKTREE: topic.worktree,
                ...(deps.engine.bin && { AID_CODEGRAPH_BIN: deps.engine.bin }),
              }),
              afterSuccess: (out) => {
                deps.actions.store.append({
                  source: 'daemon',
                  type: 'topic.state',
                  workspaceId: ws.id,
                  topicId: id,
                  data: { state: 'archived' },
                });
                if (typeof out.result.stashRef === 'string') {
                  deps.actions.store.append({
                    source: 'daemon',
                    type: 'topic.stash',
                    workspaceId: ws.id,
                    topicId: id,
                    data: { stashRef: out.result.stashRef },
                  });
                }
              },
            });
          }
        },
      });
      return reply.code(202).send({ actionId: runId });
    }

    if (actionId === 'archive.oublier-stash') {
      if (topic.stash_ref == null)
        throw new AidHttpError(409, 'aucun stash à oublier pour ce sujet');
      const ref = topic.stash_ref;
      // La pile de stash est partagée entre les worktrees liés : on résout l'index courant
      // par la SHA captée au nettoyage plutôt que de garder un stash@{n} qui se périme.
      const found = await deps.actions.queue.run(ws.id, async () => {
        const list = await git(ws.root, ['stash', 'list', '--format=%H %gd']);
        const line = list.stdout.split('\n').find((l) => l.startsWith(`${ref} `));
        const stashId = line?.split(' ')[1];
        if (!stashId) return false;
        await git(ws.root, ['stash', 'drop', stashId]);
        return true;
      });
      deps.actions.store.append({
        source: 'daemon',
        type: 'topic.stash',
        workspaceId: ws.id,
        topicId: id,
        data: { stashRef: null },
      });
      return reply.code(200).send({ found });
    }

    const body = (req.body ?? {}) as {
      confirmUnmerged?: number;
      dirtyAction?: 'stash' | 'force';
      confirmed?: boolean;
    };
    if (topic.state === 'archived') throw new AidHttpError(409, 'ce sujet est déjà archivé');
    const alive = deps.db
      .prepare(
        `SELECT a.id, a.kind FROM agents a JOIN runs r ON r.id = a.run_id
         WHERE r.topic_id = ? AND a.status IN (${LIVE.map(() => '?').join(',')})`,
      )
      .all(id, ...LIVE) as Array<{ id: string; kind: string }>;
    if (alive.length > 0) {
      throw new AidHttpError(409, 'des agents tournent encore : les arrêter avant de nettoyer', {
        agents: alive,
      });
    }
    // D21 : la case à cocher de confirmation est un garde-fou côté daemon, pas seulement côté UI.
    if (body.dirtyAction === 'force' && body.confirmed !== true) {
      throw new AidHttpError(422, 'suppression forcée : confirmation requise');
    }
    const { actionId: runId } = startAction(deps.actions, {
      workspaceId: ws.id,
      topicId: id,
      action: 'topic.cleanup',
      script: join(scripts, 'topic-cleanup.sh'),
      cwd: existsSync(topic.worktree) ? topic.worktree : ws.root,
      timeoutMs: TWO_MIN,
      env: scriptEnv(process.env, deps.config.env.strip, {
        AID_REPO_ROOT: ws.root,
        AID_TOPIC: id,
        AID_SLUG: topic.worktree.split('/').at(-1) ?? '',
        AID_BRANCH: topic.branch,
        AID_BASE: topic.base,
        AID_REMOTE: ws.remote ?? '',
        AID_WORKTREE: topic.worktree,
        ...(deps.engine.bin && { AID_CODEGRAPH_BIN: deps.engine.bin }),
        ...(body.confirmUnmerged !== undefined && {
          AID_CONFIRM_UNMERGED: String(body.confirmUnmerged),
        }),
        ...(body.dirtyAction && { AID_DIRTY_ACTION: body.dirtyAction }),
      }),
      afterSuccess: (out) => {
        deps.actions.store.append({
          source: 'daemon',
          type: 'topic.state',
          workspaceId: ws.id,
          topicId: id,
          data: { state: 'archived' },
        });
        if (typeof out.result.stashRef === 'string') {
          deps.actions.store.append({
            source: 'daemon',
            type: 'topic.stash',
            workspaceId: ws.id,
            topicId: id,
            data: { stashRef: out.result.stashRef },
          });
        }
      },
    });
    return reply.code(202).send({ actionId: runId });
  });
}
