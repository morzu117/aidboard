import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { monotonicFactory } from 'ulid';
import type { NavGroup, NavPlacement, NavState } from '../../shared/model.js';
import type { Db } from '../db.js';
import { AidHttpError } from '../errors.js';

const ulid = monotonicFactory();

// Palette de groupes (BRIEF §3) : cyclée par rang de création, dans l'ordre des tokens.
const PALETTE = [
  '#5de0a1',
  '#a78bfa',
  '#f59e6b',
  '#6ea8ff',
  '#f07ab0',
  '#f2b84b',
  '#4fd1d9',
  '#8d94a0',
];

interface GroupRow {
  id: string;
  name: string;
  color: string;
  ord: number;
  collapsed: number;
  hidden: number;
  workspace_id: string | null;
}

interface PlacementRow {
  topic_id: string;
  group_id: string;
  ord: number;
  pinned: number;
  archived: number;
  hidden: number;
  display_name: string | null;
}

function groupFromRow(r: GroupRow): NavGroup {
  return {
    id: r.id,
    name: r.name,
    color: r.color,
    ord: r.ord,
    collapsed: !!r.collapsed,
    hidden: !!r.hidden,
    workspaceId: r.workspace_id,
  };
}

function placementFromRow(r: PlacementRow): NavPlacement {
  return {
    topicId: r.topic_id,
    groupId: r.group_id,
    ord: r.ord,
    pinned: !!r.pinned,
    archived: !!r.archived,
    hidden: !!r.hidden,
    displayName: r.display_name,
  };
}

function maxGroupOrd(db: Db): number {
  return (db.prepare('SELECT COALESCE(MAX(ord), -1) AS m FROM nav_group').get() as { m: number }).m;
}

// BRIEF §5.2.2 : un groupe par projet, un nouveau projet apparaît en bas. Idempotente, appelée
// en tête de chaque route (lecture comme écriture) pour rattraper un projet ou un sujet neuf.
export function ensureNavDefaults(db: Db): void {
  const workspaces = db
    .prepare('SELECT id, name FROM workspaces ORDER BY created_at')
    .all() as Array<{ id: string; name: string }>;
  for (const w of workspaces) {
    if (db.prepare('SELECT 1 FROM nav_group WHERE workspace_id = ?').get(w.id)) continue;
    const ord = maxGroupOrd(db) + 1;
    db.prepare(
      'INSERT INTO nav_group (id, name, color, ord, collapsed, hidden, workspace_id) VALUES (?, ?, ?, ?, 0, 0, ?)',
    ).run(`ng_${ulid()}`, w.name, PALETTE[ord % PALETTE.length], ord, w.id);
  }
  const orphans = db
    .prepare(
      'SELECT t.id AS id, t.workspace_id AS workspaceId FROM topics t LEFT JOIN nav_placement p ON p.topic_id = t.id WHERE p.topic_id IS NULL',
    )
    .all() as Array<{ id: string; workspaceId: string }>;
  for (const t of orphans) {
    const group = db
      .prepare('SELECT id FROM nav_group WHERE workspace_id = ?')
      .get(t.workspaceId) as { id: string } | undefined;
    if (!group) continue;
    const ordForGroup =
      (
        db
          .prepare('SELECT COALESCE(MAX(ord), -1) AS m FROM nav_placement WHERE group_id = ?')
          .get(group.id) as { m: number }
      ).m + 1;
    db.prepare(
      'INSERT INTO nav_placement (topic_id, group_id, ord, pinned, archived, hidden, display_name) VALUES (?, ?, ?, 0, 0, 0, NULL)',
    ).run(t.id, group.id, ordForGroup);
  }
}

function readState(db: Db): NavState {
  const groups = (db.prepare('SELECT * FROM nav_group ORDER BY ord').all() as GroupRow[]).map(
    groupFromRow,
  );
  const placements = (db.prepare('SELECT * FROM nav_placement').all() as PlacementRow[]).map(
    placementFromRow,
  );
  const reduit = db.prepare("SELECT value FROM nav_pref WHERE key = 'reduit'").get() as
    { value: string } | undefined;
  return { groups, placements, prefs: { reduit: reduit?.value === '1' } };
}

const GroupBody = Type.Object(
  { name: Type.String({ minLength: 1 }), color: Type.Optional(Type.String({ minLength: 1 })) },
  { additionalProperties: false },
);
const GroupPatchBody = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1 })),
    color: Type.Optional(Type.String({ minLength: 1 })),
    collapsed: Type.Optional(Type.Boolean()),
    hidden: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
const GroupOrderBody = Type.Object(
  { ids: Type.Array(Type.String({ minLength: 1 })) },
  { additionalProperties: false },
);
const PlacementPatchBody = Type.Object(
  {
    groupId: Type.Optional(Type.String({ minLength: 1 })),
    pinned: Type.Optional(Type.Boolean()),
    archived: Type.Optional(Type.Boolean()),
    hidden: Type.Optional(Type.Boolean()),
    displayName: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
  },
  { additionalProperties: false },
);
const GroupTopicsBody = Type.Object(
  { topicIds: Type.Array(Type.String({ minLength: 1 })) },
  { additionalProperties: false },
);
const PrefsBody = Type.Object({ reduit: Type.Boolean() }, { additionalProperties: false });

export function registerNavRoutes(app: FastifyInstance, deps: { db: Db }): void {
  const { db } = deps;

  app.get('/api/nav', async () => {
    ensureNavDefaults(db);
    return readState(db);
  });

  app.post('/api/nav/groups', { schema: { body: GroupBody } }, async (req, reply) => {
    ensureNavDefaults(db);
    const body = req.body as { name: string; color?: string };
    const ord = maxGroupOrd(db) + 1;
    const group: NavGroup = {
      id: `ng_${ulid()}`,
      name: body.name,
      color: body.color ?? PALETTE[ord % PALETTE.length]!,
      ord,
      collapsed: false,
      hidden: false,
      workspaceId: null,
    };
    db.prepare(
      'INSERT INTO nav_group (id, name, color, ord, collapsed, hidden, workspace_id) VALUES (?, ?, ?, ?, 0, 0, NULL)',
    ).run(group.id, group.name, group.color, group.ord);
    return reply.code(201).send(group);
  });

  app.patch('/api/nav/groups/:id', { schema: { body: GroupPatchBody } }, async (req, reply) => {
    ensureNavDefaults(db);
    const { id } = req.params as { id: string };
    const row = db.prepare('SELECT * FROM nav_group WHERE id = ?').get(id) as GroupRow | undefined;
    if (!row) throw new AidHttpError(404, `groupe ${id} inconnu`);
    const body = req.body as {
      name?: string;
      color?: string;
      collapsed?: boolean;
      hidden?: boolean;
    };
    if (body.name !== undefined && body.name.trim().length === 0) {
      throw new AidHttpError(400, 'name ne peut pas être vide');
    }
    const next: GroupRow = {
      ...row,
      name: body.name !== undefined ? body.name.trim() : row.name,
      color: body.color ?? row.color,
      collapsed: body.collapsed !== undefined ? Number(body.collapsed) : row.collapsed,
      hidden: body.hidden !== undefined ? Number(body.hidden) : row.hidden,
    };
    db.prepare(
      'UPDATE nav_group SET name = ?, color = ?, collapsed = ?, hidden = ? WHERE id = ?',
    ).run(next.name, next.color, next.collapsed, next.hidden, id);
    return reply.code(200).send(groupFromRow(next));
  });

  app.put('/api/nav/groups/order', { schema: { body: GroupOrderBody } }, async (req, reply) => {
    ensureNavDefaults(db);
    const { ids } = req.body as { ids: string[] };
    const existing = (db.prepare('SELECT id FROM nav_group').all() as Array<{ id: string }>).map(
      (r) => r.id,
    );
    const same =
      existing.length === ids.length &&
      existing.every((id) => ids.includes(id)) &&
      new Set(ids).size === ids.length;
    if (!same) throw new AidHttpError(422, 'ids doit contenir exactement les groupes existants');
    const update = db.prepare('UPDATE nav_group SET ord = ? WHERE id = ?');
    db.transaction(() => {
      ids.forEach((id, i) => update.run(i, id));
    })();
    return reply.code(200).send(readState(db));
  });

  app.patch(
    '/api/nav/placements/:topicId',
    { schema: { body: PlacementPatchBody } },
    async (req, reply) => {
      ensureNavDefaults(db);
      const { topicId } = req.params as { topicId: string };
      const row = db.prepare('SELECT * FROM nav_placement WHERE topic_id = ?').get(topicId) as
        PlacementRow | undefined;
      if (!row) throw new AidHttpError(404, `sujet ${topicId} inconnu`);
      const body = req.body as {
        groupId?: string;
        pinned?: boolean;
        archived?: boolean;
        hidden?: boolean;
        displayName?: string | null;
      };
      let groupId = row.group_id;
      let ord = row.ord;
      if (body.groupId !== undefined && body.groupId !== row.group_id) {
        if (!db.prepare('SELECT 1 FROM nav_group WHERE id = ?').get(body.groupId)) {
          throw new AidHttpError(404, `groupe ${body.groupId} inconnu`);
        }
        groupId = body.groupId;
        ord =
          (
            db
              .prepare('SELECT COALESCE(MAX(ord), -1) AS m FROM nav_placement WHERE group_id = ?')
              .get(groupId) as { m: number }
          ).m + 1;
      }
      const next: PlacementRow = {
        ...row,
        group_id: groupId,
        ord,
        pinned: body.pinned !== undefined ? Number(body.pinned) : row.pinned,
        archived: body.archived !== undefined ? Number(body.archived) : row.archived,
        hidden: body.hidden !== undefined ? Number(body.hidden) : row.hidden,
        display_name: body.displayName !== undefined ? body.displayName : row.display_name,
      };
      db.prepare(
        'UPDATE nav_placement SET group_id = ?, ord = ?, pinned = ?, archived = ?, hidden = ?, display_name = ? WHERE topic_id = ?',
      ).run(
        next.group_id,
        next.ord,
        next.pinned,
        next.archived,
        next.hidden,
        next.display_name,
        topicId,
      );
      return reply.code(200).send(placementFromRow(next));
    },
  );

  app.put(
    '/api/nav/groups/:id/topics',
    { schema: { body: GroupTopicsBody } },
    async (req, reply) => {
      ensureNavDefaults(db);
      const { id } = req.params as { id: string };
      if (!db.prepare('SELECT 1 FROM nav_group WHERE id = ?').get(id)) {
        throw new AidHttpError(404, `groupe ${id} inconnu`);
      }
      const { topicIds } = req.body as { topicIds: string[] };
      const existing = (
        db.prepare('SELECT topic_id FROM nav_placement WHERE group_id = ?').all(id) as Array<{
          topic_id: string;
        }>
      ).map((r) => r.topic_id);
      const same =
        existing.length === topicIds.length &&
        existing.every((t) => topicIds.includes(t)) &&
        new Set(topicIds).size === topicIds.length;
      if (!same) {
        throw new AidHttpError(422, 'topicIds doit contenir exactement les sujets du groupe');
      }
      const update = db.prepare('UPDATE nav_placement SET ord = ? WHERE topic_id = ?');
      db.transaction(() => {
        topicIds.forEach((t, i) => update.run(i, t));
      })();
      return reply.code(200).send(readState(db));
    },
  );

  app.patch('/api/nav/prefs', { schema: { body: PrefsBody } }, async (req, reply) => {
    ensureNavDefaults(db);
    const { reduit } = req.body as { reduit: boolean };
    db.prepare(
      'INSERT INTO nav_pref (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run('reduit', reduit ? '1' : '0');
    return reply.code(200).send({ reduit });
  });
}
