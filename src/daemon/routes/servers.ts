import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { monotonicFactory } from 'ulid';
import type { Db } from '../db.js';
import { AidHttpError } from '../errors.js';
import {
  assertNameFree,
  getServer,
  listServers,
  type ServerInput,
  validateServer,
} from '../remote/servers.js';

const ulid = monotonicFactory();

const Nullable = <T extends Parameters<typeof Type.Union>[0][number]>(t: T) =>
  Type.Union([t, Type.Null()]);

const SshOptions = Type.Object(
  {
    port: Nullable(Type.Integer()),
    user: Nullable(Type.String()),
    identityFile: Nullable(Type.String()),
    jump: Nullable(Type.String()),
  },
  { additionalProperties: false },
);

const editable = {
  sshOptions: Type.Optional(Nullable(SshOptions)),
  loadProfile: Type.Optional(Type.Boolean()),
  workdir: Type.Optional(Type.String()),
  shell: Type.Optional(Type.String()),
  keepSession: Type.Optional(Type.Boolean()),
  permissionMode: Type.Optional(Type.String()),
  confirmDestructive: Type.Optional(Type.Boolean()),
  allowedDirs: Type.Optional(Type.Array(Type.String())),
  groupName: Type.Optional(Type.String()),
  color: Type.Optional(Type.String()),
};

const CreateBody = Type.Object(
  { name: Type.String(), mode: Type.String(), target: Type.String(), ...editable },
  { additionalProperties: false },
);
const PatchBody = Type.Object(
  {
    name: Type.Optional(Type.String()),
    mode: Type.Optional(Type.String()),
    target: Type.Optional(Type.String()),
    ...editable,
  },
  { additionalProperties: false },
);

function write(db: Db, id: string, s: Required<ServerInput>, now: string, createdAt?: string) {
  const values = {
    id,
    name: s.name,
    mode: s.mode,
    target: s.target,
    ssh_options: s.sshOptions === null ? null : JSON.stringify(s.sshOptions),
    load_profile: s.loadProfile ? 1 : 0,
    workdir: s.workdir,
    shell: s.shell,
    keep_session: s.keepSession ? 1 : 0,
    permission_mode: s.permissionMode,
    confirm_destructive: s.confirmDestructive ? 1 : 0,
    allowed_dirs: JSON.stringify(s.allowedDirs),
    group_name: s.groupName,
    color: s.color,
    updated_at: now,
  };
  if (createdAt !== undefined) {
    db.prepare(
      `INSERT INTO servers (id, name, mode, target, ssh_options, load_profile, workdir, shell, keep_session,
         permission_mode, confirm_destructive, allowed_dirs, group_name, color, created_at, updated_at)
       VALUES (@id, @name, @mode, @target, @ssh_options, @load_profile, @workdir, @shell, @keep_session,
         @permission_mode, @confirm_destructive, @allowed_dirs, @group_name, @color, @created_at, @updated_at)`,
    ).run({ ...values, created_at: createdAt });
    return;
  }
  db.prepare(
    `UPDATE servers SET name = @name, mode = @mode, target = @target, ssh_options = @ssh_options,
       load_profile = @load_profile, workdir = @workdir, shell = @shell, keep_session = @keep_session,
       permission_mode = @permission_mode, confirm_destructive = @confirm_destructive,
       allowed_dirs = @allowed_dirs, group_name = @group_name, color = @color, updated_at = @updated_at
     WHERE id = @id`,
  ).run(values);
}

/**
 * Chantier 17 (S.1) : serveurs distants. Réservé à l'administrateur — un token de run est déjà refusé
 * hors `/api/events`, `/api/memory/`, `/api/structural/` par `security.ts`.
 */
export function registerServerRoutes(app: FastifyInstance, deps: { db: Db }): void {
  const { db } = deps;
  const found = (id: string) => {
    const server = getServer(db, id);
    if (!server) throw new AidHttpError(404, `serveur ${id} inconnu`);
    return server;
  };

  app.get('/api/servers', async () => listServers(db));

  app.get('/api/servers/:id', async (req) => found((req.params as { id: string }).id));

  app.post('/api/servers', { schema: { body: CreateBody } }, async (req, reply) => {
    const s = validateServer(req.body as ServerInput);
    const id = `srv_${ulid()}`;
    const now = new Date().toISOString();
    db.transaction(() => {
      assertNameFree(db, s.name);
      write(db, id, s, now, now);
    })();
    return reply.code(201).send(found(id));
  });

  app.patch('/api/servers/:id', { schema: { body: PatchBody } }, async (req) => {
    const current = found((req.params as { id: string }).id);
    const s = validateServer({ ...current, ...(req.body as Partial<ServerInput>) });
    db.transaction(() => {
      assertNameFree(db, s.name, current.id);
      write(db, current.id, s, new Date().toISOString());
    })();
    return found(current.id);
  });

  // §11.2 : retire le serveur d'A-I-D seulement, rien n'est exécuté sur le serveur.
  app.delete('/api/servers/:id', async (req, reply) => {
    const server = found((req.params as { id: string }).id);
    db.prepare('DELETE FROM servers WHERE id = ?').run(server.id);
    return reply.code(204).send();
  });

  app.delete('/api/servers/:id/rules/:ruleId', async (req) => {
    const { id, ruleId } = req.params as { id: string; ruleId: string };
    const server = found(id);
    const r = db
      .prepare('DELETE FROM server_rules WHERE id = ? AND server_id = ?')
      .run(ruleId, server.id);
    if (r.changes === 0) throw new AidHttpError(404, `règle ${ruleId} inconnue`);
    return found(server.id);
  });
}
