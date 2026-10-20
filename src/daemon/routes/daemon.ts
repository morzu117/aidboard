import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db.js';
import { AidHttpError } from '../errors.js';
import type { UpdateStatus } from '../updateCheck.js';
import type { InstallMode, UpdateInfo } from '../../shared/model.js';

const LIVE = ['starting', 'working', 'needs_input', 'idle'];
const Body = Type.Optional(
  Type.Object({ force: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
);

function aliveAgents(db: Db): Array<{ id: string; kind: string }> {
  return db
    .prepare(`SELECT id, kind FROM agents WHERE status IN (${LIVE.map(() => '?').join(',')})`)
    .all(...LIVE) as Array<{ id: string; kind: string }>;
}

// Arrêter (ou mettre à jour, qui arrête puis relance) le daemon tue ses agents (ce sont ses
// enfants) : sans --force, on refuse tant qu'il en reste de vivants.
export function registerDaemonRoutes(
  app: FastifyInstance,
  deps: {
    db: Db;
    requestStop: () => void;
    requestUpdate?: () => void;
    requestCycle?: () => void;
    updates?: () => UpdateStatus | null;
    updateError?: () => string | null;
    /** 13.2 : mode d'installation et version du build qui tourne (DR5) */
    install?: () => { mode: InstallMode; version: string };
    resetSession?: () => void;
  },
): void {
  // `lastError` reflète la dernière tentative de MAJ (pull ou build), pas la comparaison git
  // d'`updates` : sans lui, un échec silencieux côté daemon laisse le bouton de l'UI bloqué sans
  // jamais dire pourquoi (constaté : `git pull --ff-only` refusé par historique divergent).
  app.get('/api/daemon/update', async (): Promise<UpdateInfo> => {
    const status = deps.updates?.() ?? null;
    const install = deps.install?.() ?? { mode: 'inconnu' as const, version: '0.0.0' };
    return {
      mode: install.mode,
      version: install.version,
      available: status?.available ?? false,
      latest: status?.available ? status.remoteSha : null,
      lastError: deps.updateError?.() ?? null,
    };
  });
  // révoque toutes les sessions navigateur (aid open --reset) ; le jeton admin n'est pas touché
  app.post('/api/session/reset', async (_req, reply) => {
    if (!deps.resetSession) throw new AidHttpError(501, 'révocation non disponible');
    deps.resetSession();
    return reply.code(204).send();
  });
  app.post('/api/daemon/stop', { schema: { body: Body } }, async (req, reply) => {
    const force = (req.body as { force?: boolean } | undefined)?.force === true;
    const alive = aliveAgents(deps.db);
    if (alive.length > 0 && !force) {
      throw new AidHttpError(
        409,
        `${alive.length} agent(s) tournent encore : --force pour tout arrêter`,
        { agents: alive },
      );
    }
    reply.code(202).send({ stopping: true, agents: alive.length });
    setImmediate(deps.requestStop);
  });
  app.post('/api/daemon/update', { schema: { body: Body } }, async (req, reply) => {
    if (!deps.requestUpdate) throw new AidHttpError(501, 'mise à jour non disponible');
    const force = (req.body as { force?: boolean } | undefined)?.force === true;
    const alive = aliveAgents(deps.db);
    if (alive.length > 0 && !force) {
      throw new AidHttpError(
        409,
        `${alive.length} agent(s) tournent encore : --force pour tout arrêter et mettre à jour`,
        { agents: alive },
      );
    }
    reply.code(202).send({ updating: true, agents: alive.length });
    setImmediate(deps.requestUpdate);
  });
  // Troisième voie, à côté du refus (409) et du --force : interrompt proprement les agents vivants
  // (résumé écrit avant l'arrêt) puis redémarre. Appelée par `aid` à l'ouverture d'AID.app.
  app.post('/api/daemon/cycle', async (_req, reply) => {
    if (!deps.requestCycle) throw new AidHttpError(501, 'cycle non disponible');
    reply.code(202).send({ cycling: true });
    setImmediate(deps.requestCycle);
  });
}
