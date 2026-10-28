import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { monotonicFactory } from 'ulid';
import { isValidSlug, slugify } from '../../shared/slug.js';
import { type ActionContext, scriptEnv, startAction } from '../actions/service.js';
import { diffCommand, editorCommand, openDiffInEditor, openInEditor } from '../actions/editor.js';
import { findAssetDir } from '../assets.js';
import type { AidConfig } from '../config.js';
import type { Db } from '../db.js';
import { AidHttpError } from '../errors.js';
import { git } from '../git/exec.js';
import {
  branchWorktree,
  currentBranch,
  fileAtRevision,
  gitBranches,
  gitCommitDetail,
  gitLiveInfo,
  gitLog,
  hasUncommittedChanges,
  hasUncommittedOrOperationInProgress,
  liberationTarget,
} from '../git/inspect.js';
import { resolveUnderWorktree } from './files.js';
import type { StructuralService } from '../structural/service.js';
import type { Indexer } from '../topics/index.js';

// 11.11 (D32) : garde légère pour un chemin de fichier dans un diff — le fichier peut avoir
// disparu du worktree courant (commit historique), resolveUnderWorktree (qui exige son
// existence réelle) ne convient donc qu'à editeur.ouvrir-fichier, jamais à diff.ouvrir-fichier.
function isTraversal(relPath: string): boolean {
  return relPath.split('/').some((seg) => seg === '..' || seg === '');
}

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
  'topic.branch-changer',
  'branche.creer',
  'branche.creer-ici',
  'branche.revenir',
  'sujet.rattacher-branche',
  'editeur.ouvrir-fichier',
  'diff.ouvrir',
  'diff.ouvrir-fichier',
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
          deps.db.prepare('DELETE FROM nav_placement WHERE topic_id = ?').run(topicId);
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
    const row = deps.db
      .prepare('SELECT worktree, base, branch FROM topics WHERE id = ?')
      .get(id) as { worktree: string; base: string; branch: string } | undefined;
    if (!row) throw new AidHttpError(404, 'sujet inconnu');
    if (!existsSync(row.worktree)) throw new AidHttpError(409, 'worktree introuvable');
    const [commits, dirty, live] = await Promise.all([
      gitLog(row.worktree, row.base),
      hasUncommittedChanges(row.worktree),
      // 11.10 : la branche du sujet était absente de cet appel — onTopicBranch (D28) valait
      // toujours vrai en pratique, le bandeau de dérive (3.6) ne pouvait jamais s'afficher.
      gitLiveInfo(row.worktree, row.base, row.branch),
    ]);
    return { commits, dirty, live };
  });

  // 11.5 (D25/D26) : liste des branches locales — le regroupement (branche du sujet /
  // branches liées / autres) se fait côté client à partir de isCurrent/topicId.
  app.get('/api/topics/:id/git/branches', async (req) => {
    const { id } = req.params as { id: string };
    const row = deps.db
      .prepare('SELECT worktree, base, branch, workspace_id FROM topics WHERE id = ?')
      .get(id) as
      { worktree: string; base: string; branch: string; workspace_id: string } | undefined;
    if (!row) throw new AidHttpError(404, 'sujet inconnu');
    if (!existsSync(row.worktree)) throw new AidHttpError(409, 'worktree introuvable');
    // `git worktree list` rend des chemins résolus (symlinks macOS /tmp, /var...) : comparer
    // au réel de row.worktree, pas à sa forme littérale telle que stockée en base.
    const real = realpathSync(row.worktree);
    const branches = await gitBranches(row.worktree, row.base);
    const topicByBranch = new Map(
      (
        deps.db
          .prepare(
            "SELECT branch, id FROM topics WHERE workspace_id = ? AND id != ? AND state != 'archived'",
          )
          .all(row.workspace_id, id) as Array<{ branch: string; id: string }>
      ).map((t) => [t.branch, t.id]),
    );
    // C9 : la requête workspaces ne sert qu'à liberationTarget — inutile si aucune branche
    // n'est extraite ailleurs ; cast non gardé remplacé par une erreur explicite si absente.
    const uneAilleurs = branches.some((b) => b.worktree !== null && b.worktree !== real);
    let ws: { root: string; base_branch: string } | undefined;
    if (uneAilleurs) {
      ws = deps.db
        .prepare('SELECT root, base_branch FROM workspaces WHERE id = ?')
        .get(row.workspace_id) as { root: string; base_branch: string } | undefined;
      if (!ws) throw new AidHttpError(404, 'workspace inconnu');
    }
    return {
      branches: await Promise.all(
        branches.map(async (b) => {
          const ailleurs = b.worktree !== null && b.worktree !== real;
          // C3 : la base du WORKSPACE partout, jamais celle (possiblement différente) du sujet.
          const liberation = ailleurs
            ? await liberationTarget(ws!.root, ws!.base_branch, b.worktree!)
            : null;
          return {
            ...b,
            isCurrent: b.name === row.branch,
            worktree: b.worktree === real ? null : b.worktree,
            topicId: topicByBranch.get(b.name) ?? null,
            ...(liberation && {
              liberationVers: liberation.vers,
              liberationRacine: liberation.racine,
            }),
          };
        }),
      ),
    };
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

    // 11.11 (D32) : extension d'editor.open à un chemin de fichier précis (le patron
    // {path} existe déjà dans openInEditor) — seule action de ce trio avec un consommateur
    // front (OngletFichiers.tsx, 11.8), donc la seule à exiger l'existence réelle du fichier.
    if (actionId === 'editeur.ouvrir-fichier') {
      if (!existsSync(topic.worktree)) throw new AidHttpError(409, 'worktree introuvable');
      const body = (req.body ?? {}) as { path?: string };
      if (!body.path) throw new AidHttpError(422, 'chemin requis');
      const full = resolveUnderWorktree(topic.worktree, body.path);
      const cmd = editorCommand(deps.config.editor);
      try {
        await openInEditor(cmd, full);
      } catch (err) {
        throw new AidHttpError(
          422,
          `impossible de lancer l'éditeur (${cmd.join(' ')}) : ${(err as Error).message}. Régler « editor » dans ~/.aid/config.yaml.`,
        );
      }
      return reply.code(204).send();
    }

    // D32 : pas de visualiseur de diff multi-fichiers en app, et aucun éditeur ne déclare de
    // contrat générique pour differ un commit entier (seul un fichier précis en a un, cf.
    // diff.ouvrir-fichier ci-dessous) — repli déclaré sur l'ouverture du worktree.
    if (actionId === 'diff.ouvrir') {
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

    // D32 : diff natif (ex. `code --diff`) quand l'éditeur configuré en déclare un (avant/après
    // écrits dans des fichiers temporaires, le worktree courant n'a pas forcément cette
    // version) ; sinon repli déclaré sur l'ouverture simple du fichier courant — pas un échec.
    if (actionId === 'diff.ouvrir-fichier') {
      if (!existsSync(topic.worktree)) throw new AidHttpError(409, 'worktree introuvable');
      const body = (req.body ?? {}) as { hash?: string; path?: string };
      if (!body.hash || !body.path) throw new AidHttpError(422, 'hash et chemin requis');
      if (isTraversal(body.path)) throw new AidHttpError(422, `${body.path} sort du worktree`);
      const cmd = editorCommand(deps.config.editor);
      const diff = diffCommand(cmd);
      if (!diff) {
        const full = resolveUnderWorktree(topic.worktree, body.path);
        try {
          await openInEditor(cmd, full);
        } catch (err) {
          throw new AidHttpError(
            422,
            `impossible de lancer l'éditeur (${cmd.join(' ')}) : ${(err as Error).message}. Régler « editor » dans ~/.aid/config.yaml.`,
          );
        }
        return reply.code(204).send();
      }
      const [before, after] = await Promise.all([
        fileAtRevision(topic.worktree, `${body.hash}^`, body.path),
        fileAtRevision(topic.worktree, body.hash, body.path),
      ]);
      const tmp = mkdtempSync(join(tmpdir(), 'aid-diff-'));
      const beforeDir = join(tmp, 'avant');
      const afterDir = join(tmp, 'apres');
      mkdirSync(beforeDir);
      mkdirSync(afterDir);
      const name = basename(body.path);
      const beforePath = join(beforeDir, name);
      const afterPath = join(afterDir, name);
      writeFileSync(beforePath, before ?? '');
      writeFileSync(afterPath, after ?? '');
      try {
        await openDiffInEditor(diff, beforePath, afterPath);
      } catch (err) {
        throw new AidHttpError(
          422,
          `impossible de lancer l'éditeur (${diff.join(' ')}) : ${(err as Error).message}. Régler « editor » dans ~/.aid/config.yaml.`,
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
        deps.db.prepare('DELETE FROM nav_placement WHERE topic_id = ?').run(id);
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

    // D25 : même file que topic.sync, via topic-switch.sh. Le refus « déjà extraite
    // ailleurs » est vérifié ici (409 synchrone) plutôt que laissé au script (die_human/2
    // ne se traduit pas en HTTP, l'action tourne en file et son issue est async).
    if (actionId === 'topic.branch-changer') {
      if (!existsSync(topic.worktree)) throw new AidHttpError(409, 'worktree introuvable');
      const body = (req.body ?? {}) as {
        targetBranch?: string;
        dirtyAction?: 'stash';
        liberer?: boolean;
      };
      if (!body.targetBranch) throw new AidHttpError(422, 'branche cible requise');
      const elsewhere = await branchWorktree(ws.root, body.targetBranch);
      const envLiberer: Record<string, string> = {};
      if (elsewhere && elsewhere !== realpathSync(topic.worktree)) {
        if (!body.liberer) {
          throw new AidHttpError(
            409,
            `la branche ${body.targetBranch} est déjà extraite dans ${elsewhere}`,
          );
        }
        // 15 : « a » (X appartient au même dépôt) tient par construction — elsewhere vient de
        // `git worktree list` sur ws.root ; seule son existence réelle reste à vérifier (worktree
        // enregistré par git mais dossier disparu hors A-I-D, jamais pruné).
        if (!existsSync(elsewhere)) {
          throw new AidHttpError(409, `${elsewhere} est introuvable : git worktree prune`);
        }
        // C8 : (c) avant (b) — un agent qui écrit dans X rend le conseil « commit ou mise de
        // côté là-bas » de (b) inapplicable, donc le refus le plus actionnable doit sortir en premier.
        // 15 (c) : X vivant d'un sujet A-I-D avec agent actif → refus synchrone, die_human ne
        // couvre que la propreté (b) dans le script, pas la liveness.
        const owner = (
          deps.db
            .prepare(
              "SELECT id, slug, worktree FROM topics WHERE workspace_id = ? AND id != ? AND state != 'archived'",
            )
            .all(ws.id, id) as Array<{ id: string; slug: string; worktree: string }>
        ).find((t) => existsSync(t.worktree) && realpathSync(t.worktree) === elsewhere);
        if (owner) {
          const alive = deps.db
            .prepare(
              `SELECT a.id FROM agents a JOIN runs r ON r.id = a.run_id
               WHERE r.topic_id = ? AND a.status IN (${LIVE.map(() => '?').join(',')})`,
            )
            .all(owner.id, ...LIVE) as Array<{ id: string }>;
          if (alive.length > 0) {
            throw new AidHttpError(409, `un agent tourne dans le sujet ${owner.slug}`);
          }
        }
        // 15 (b) / review (3) : même vérification que le script (die_human), doublée ici pour
        // un refus 409 synchrone plutôt qu'une action async qui bascule en needs_human.
        if (await hasUncommittedOrOperationInProgress(elsewhere)) {
          throw new AidHttpError(
            409,
            `${elsewhere} a des modifications non commitées : commit ou mise de côté là-bas d'abord`,
          );
        }
        // 15 (d) : la racine libérée bascule sur la base si celle-ci n'est extraite nulle part,
        // sinon détachée — exécuté par le script (seul maître des worktrees), décidé ici.
        const liberation = await liberationTarget(ws.root, ws.base_branch, elsewhere);
        envLiberer.AID_LIBERER = '1';
        envLiberer.AID_LIBERER_DOSSIER = elsewhere;
        if (liberation.vers) envLiberer.AID_LIBERER_VERS = liberation.vers;
      }
      const { actionId: runId } = startAction(deps.actions, {
        workspaceId: ws.id,
        topicId: id,
        action: 'topic.branch-changer',
        script: join(scripts, 'topic-switch.sh'),
        cwd: topic.worktree,
        timeoutMs: TWO_MIN,
        env: scriptEnv(process.env, deps.config.env.strip, {
          AID_REPO_ROOT: ws.root,
          AID_BRANCH: topic.branch,
          AID_WORKTREE: topic.worktree,
          AID_TARGET_BRANCH: body.targetBranch,
          ...(body.dirtyAction && { AID_DIRTY_ACTION: body.dirtyAction }),
          ...envLiberer,
        }),
      });
      return reply.code(202).send({ actionId: runId });
    }

    // D26 : même script, AID_CREATE=1 — ne change jamais topics.branch ni l'état du sujet.
    if (actionId === 'branche.creer' || actionId === 'branche.creer-ici') {
      if (!existsSync(topic.worktree)) throw new AidHttpError(409, 'worktree introuvable');
      const body = (req.body ?? {}) as { targetBranch?: string; dirtyAction?: 'stash' };
      if (!body.targetBranch) throw new AidHttpError(422, 'nom de branche requis');
      const { actionId: runId } = startAction(deps.actions, {
        workspaceId: ws.id,
        topicId: id,
        action: actionId,
        script: join(scripts, 'topic-switch.sh'),
        cwd: topic.worktree,
        timeoutMs: TWO_MIN,
        env: scriptEnv(process.env, deps.config.env.strip, {
          AID_REPO_ROOT: ws.root,
          AID_BRANCH: topic.branch,
          AID_WORKTREE: topic.worktree,
          AID_TARGET_BRANCH: body.targetBranch,
          AID_CREATE: '1',
          ...(actionId === 'branche.creer' && { AID_CREATE_FROM: 'base', AID_BASE: topic.base }),
          ...(body.dirtyAction && { AID_DIRTY_ACTION: body.dirtyAction }),
        }),
      });
      return reply.code(202).send({ actionId: runId });
    }

    // 11.10 (D27) : même script que topic.branch-changer, cible toujours topic.branch — pas de
    // paramètre côté client, contrairement à topic.branch-changer.
    if (actionId === 'branche.revenir') {
      if (!existsSync(topic.worktree)) throw new AidHttpError(409, 'worktree introuvable');
      const body = (req.body ?? {}) as { dirtyAction?: 'stash' };
      const elsewhere = await branchWorktree(ws.root, topic.branch);
      if (elsewhere && elsewhere !== realpathSync(topic.worktree)) {
        throw new AidHttpError(
          409,
          `la branche ${topic.branch} est déjà extraite dans ${elsewhere}`,
        );
      }
      // topic-switch.sh no-op si AID_BRANCH === AID_TARGET_BRANCH (déjà sur la branche visée) :
      // la vraie branche courante du worktree, jamais topic.branch, sous peine de no-op permanent
      // en dérive (AID_BRANCH toujours égal à la cible) — '(détachée)' en HEAD détachée, une
      // valeur qui ne collisionne jamais avec un nom de branche réel.
      const head = await currentBranch(topic.worktree);
      const { actionId: runId } = startAction(deps.actions, {
        workspaceId: ws.id,
        topicId: id,
        action: 'branche.revenir',
        script: join(scripts, 'topic-switch.sh'),
        cwd: topic.worktree,
        timeoutMs: TWO_MIN,
        env: scriptEnv(process.env, deps.config.env.strip, {
          AID_REPO_ROOT: ws.root,
          AID_BRANCH: head ?? '(détachée)',
          AID_WORKTREE: topic.worktree,
          AID_TARGET_BRANCH: topic.branch,
          ...(body.dirtyAction && { AID_DIRTY_ACTION: body.dirtyAction }),
        }),
      });
      return reply.code(202).send({ actionId: runId });
    }

    // D27 : seule action de ce chantier qui écrit en base — synchrone, même motif que
    // syncTopicBranches (événement topic.branch, aucune migration).
    if (actionId === 'sujet.rattacher-branche') {
      if (!existsSync(topic.worktree)) throw new AidHttpError(409, 'worktree introuvable');
      const head = await currentBranch(topic.worktree);
      if (!head) throw new AidHttpError(422, 'HEAD détachée : aucune branche à rattacher');
      deps.actions.store.append({
        source: 'daemon',
        type: 'topic.branch',
        workspaceId: ws.id,
        topicId: id,
        data: { branch: head },
      });
      return reply.code(200).send({ branch: head });
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
