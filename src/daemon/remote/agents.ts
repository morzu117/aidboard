import { randomUUID } from 'node:crypto';
import { monotonicFactory } from 'ulid';
import type { AgentSettings, PermissionMode } from '../../shared/agentSettings.js';
import { agentOptions, type AgentOptions, type ModelOption } from '../../shared/agentSettings.js';
import type {
  AgentStatus,
  PendingRequest,
  Server,
  ServerAgent,
  ServerDiscussion,
  ServerRule,
} from '../../shared/model.js';
import { ClaudeDriver } from '../conversation/claude.js';
import { CodexDriver } from '../conversation/codex.js';
import type { ConversationDriver, ConversationEvent } from '../conversation/driver.js';
import type { Db } from '../db.js';
import { AidHttpError } from '../errors.js';
import { CONFIRM_OPTIONS, claudeConfirmSettings, isDestructive, rulePattern } from './confirm.js';
import { RemoteDriver } from './driver.js';
import { parseAlive, relayAlive, relayStop } from './relay.js';
import { getServer } from './servers.js';
import { SERVER_PERMISSION_MODES } from './servers.js';
import { remoteExec, type TransportOptions } from './transport.js';

const ulid = monotonicFactory();

export type RemoteKind = ServerAgent['kind'];
const KINDS: readonly RemoteKind[] = ['claude', 'codex'];
const NAME_MAX = 120;
/** Statuts d'un agent qui ne tourne plus : rien à rattacher au redémarrage du daemon. */
const FINISHED: readonly AgentStatus[] = ['done', 'error', 'stopped'];

interface DiscussionRow {
  id: string;
  server_id: string;
  name: string;
  cwd: string;
  archived: number;
  created_at: string;
  updated_at: string;
}

interface AgentRow {
  id: string;
  discussion_id: string;
  kind: RemoteKind;
  session_id: string | null;
  status: AgentStatus;
  tmux_session: string | null;
  out_offset: number;
  permission_mode: PermissionMode;
  model: string | null;
  effort: string | null;
  created_at: string;
  updated_at: string;
}

type Exit = { exitCode: number | null; signal: NodeJS.Signals | null; reason: string };

/** Un agent distant en mémoire : son pilote, le numéro de ligne de son fil, sa demande en cours. */
export interface LiveRemote {
  id: string;
  discussionId: string;
  driver: RemoteDriver;
  seq: number;
  exited: boolean;
  exit: Exit | null;
  stopReason?: string;
  pending: PendingRequest | null;
  /** demandes arrivées pendant qu'une autre est en cours : présentées une à une */
  queued: PendingRequest[];
  /** R.5 (D77) : confirmation des commandes destructives, fixée au lancement ; nulle si le serveur ne la demande pas */
  confirm: Confirm | null;
  /** Dossier de la discussion : une règle « Toujours autoriser » n'y vaut que là (décision du 2026-10-31) */
  cwd: string;
  subscribe(cb: (ev: ConversationEvent) => void): () => void;
  /**
   * Chantier 19, S.5 (DS4) : relance d'un claude dont le critère de reprise (`hasTurn`) peut se tromper. Tant que
   * l'agent n'a rien dit, un refus au démarrage est retenté une fois avec le critère inverse, les messages renvoyés.
   */
  retry?: { resume: boolean; texts: string[] };
}

/** `autoApprove` : codex en mode auto, lancé en `untrusted` ; le daemon laisse passer ce qui n'est pas destructif. */
interface Confirm {
  server: string;
  autoApprove: boolean;
}

export type ServerAgentView = ServerAgent & { pending: PendingRequest | null };
export type ServerDiscussionView = ServerDiscussion & { agents: ServerAgentView[] };

export interface RemoteAgentManagerDeps {
  db: Db;
  transport: TransportOptions;
  /** Binaire lancé sur le serveur, par agent ; défaut : son nom, cherché dans le PATH distant. Les tests y mettent les faux. */
  bins?: Partial<Record<RemoteKind, string>>;
  delaysMs?: readonly number[];
}

const PREFIX = 'aid-';
/**
 * Décision opérateur du 2026-10-31 (review complète) : claude en `auto` ne soumet que ce que ses règles `ask`
 * rattrapent — `/bin/rm`, `git -C x push`, `find -delete` passeraient sans carte. Sous confirmation, pas d'`auto`
 * pour claude ; codex, lui, soumet tout au tri du daemon (`untrusted`).
 */
const claudeSansAuto = (kind: RemoteKind, server: Pick<Server, 'confirmDestructive'>) =>
  kind === 'claude' && server.confirmDestructive;
/** Décision D.2 : des agents peut-être encore en marche sur le serveur, la suppression attend un « quand même ». */
function assertStopped(unconfirmed: number, force: boolean): void {
  if (unconfirmed === 0 || force) return;
  throw new AidHttpError(
    409,
    `arrêt non confirmé par le serveur (${unconfirmed} agent${unconfirmed > 1 ? 's' : ''}) : ` +
      'il y tourne peut-être encore',
    { unconfirmed },
  );
}
const relayOf = (row: Pick<AgentRow, 'id' | 'tmux_session'>) =>
  row.tmux_session?.startsWith(PREFIX) ? row.tmux_session.slice(PREFIX.length) : row.id;

const discussionOf = (r: DiscussionRow): ServerDiscussion => ({
  id: r.id,
  serverId: r.server_id,
  name: r.name,
  cwd: r.cwd,
  archived: r.archived === 1,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/**
 * Chantier 17 (R.4, D74) : les agents des discussions sur un serveur, à côté d'`AgentManager` qui reste inchangé.
 * Même journal que les agents d'un sujet (une ligne par événement, `thinking` excepté), dans
 * `server_agent_messages` ; l'offset de sortie du relais est écrit dans la même transaction que la ligne, pour
 * qu'un rattachement après un redémarrage ne perde ni ne rejoue rien.
 */
export class RemoteAgentManager {
  private live = new Map<string, LiveRemote>();
  /** par agent, pas par pilote : un canal ouvert suit l'agent à travers ses relances (comme `streamSubscribers`) */
  private subscribers = new Map<string, Set<(ev: ConversationEvent) => void>>();
  /** discussions et serveurs en cours de suppression : rien ne s'y lance ni ne s'y relance (revue R.4) */
  private closing = new Set<string>();
  /** relances en cours, une par agent : deux messages simultanés ne lancent pas deux relais */
  private relaunching = new Map<string, Promise<LiveRemote>>();
  /** dernier catalogue de modèles codex vu sur un pilote vivant (D71) */
  private codexCatalog: ModelOption[] = [];

  constructor(private readonly deps: RemoteAgentManagerDeps) {}

  // ---- lecture

  listDiscussions(serverId: string): ServerDiscussionView[] {
    const rows = this.deps.db
      .prepare('SELECT * FROM server_discussions WHERE server_id = ? ORDER BY updated_at DESC')
      .all(serverId) as DiscussionRow[];
    return rows.map((r) => this.discussionView(r));
  }

  discussion(serverId: string, discussionId: string): ServerDiscussionView {
    return this.discussionView(this.discussionRow(serverId, discussionId));
  }

  agent(agentId: string): ServerAgentView {
    return this.agentView(this.agentRow(agentId));
  }

  getLive(agentId: string): LiveRemote | undefined {
    return this.live.get(agentId);
  }

  private discussionRow(serverId: string, discussionId: string): DiscussionRow {
    const row = this.deps.db
      .prepare('SELECT * FROM server_discussions WHERE id = ? AND server_id = ?')
      .get(discussionId, serverId) as DiscussionRow | undefined;
    if (!row) throw new AidHttpError(404, `discussion ${discussionId} inconnue`);
    return row;
  }

  private agentRow(agentId: string): AgentRow {
    const row = this.deps.db.prepare('SELECT * FROM server_agents WHERE id = ?').get(agentId) as
      AgentRow | undefined;
    if (!row) throw new AidHttpError(404, `agent ${agentId} inconnu`);
    return row;
  }

  private discussionView(r: DiscussionRow): ServerDiscussionView {
    const agents = this.deps.db
      .prepare('SELECT * FROM server_agents WHERE discussion_id = ? ORDER BY created_at')
      .all(r.id) as AgentRow[];
    return { ...discussionOf(r), agents: agents.map((a) => this.agentView(a)) };
  }

  private agentView(r: AgentRow): ServerAgentView {
    return {
      id: r.id,
      discussionId: r.discussion_id,
      kind: r.kind,
      sessionId: r.session_id,
      status: r.status,
      tmuxSession: r.tmux_session,
      outOffset: r.out_offset,
      permissionMode: r.permission_mode,
      model: r.model,
      effort: r.effort,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      pending: this.live.get(r.id)?.pending ?? null,
    };
  }

  // ---- discussions

  /** Une discussion et son agent, lancé tout de suite. Seuls les agents détectés au dernier test sont proposés. */
  createDiscussion(
    server: Server,
    body: { name: string; kind: string; cwd?: string },
  ): ServerDiscussionView {
    const name = body.name.trim();
    if (!name || name.length > NAME_MAX)
      throw new AidHttpError(422, `nom de discussion vide ou de plus de ${NAME_MAX} caractères`);
    const kind = body.kind as RemoteKind;
    if (!KINDS.includes(kind))
      throw new AidHttpError(422, `agent non pris en charge : ${body.kind}`);
    if (server.detectedAgents === null)
      throw new AidHttpError(409, 'serveur jamais testé : lancer le test de connexion d’abord');
    if (!server.detectedAgents.includes(kind))
      throw new AidHttpError(409, `${kind} n’a pas été détecté sur ${server.name} au dernier test`);
    const cwd = (body.cwd ?? server.workdir).trim() || server.workdir;
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(cwd) || !/^[/~]/.test(cwd))
      throw new AidHttpError(422, 'répertoire invalide : chemin absolu ou sous ~ attendu');
    if (this.closing.has(server.id)) throw new AidHttpError(409, 'serveur en cours de suppression');

    const discussionId = `sd_${ulid()}`;
    const agentId = `sa_${ulid()}`;
    const now = new Date().toISOString();
    const sessionId = kind === 'claude' ? randomUUID() : null;
    this.deps.db.transaction(() => {
      this.deps.db
        .prepare(
          'INSERT INTO server_discussions (id, server_id, name, cwd, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(discussionId, server.id, name, cwd, now, now);
      this.deps.db
        .prepare(
          `INSERT INTO server_agents (id, discussion_id, kind, session_id, status, tmux_session, permission_mode,
             created_at, updated_at) VALUES (?, ?, ?, ?, 'starting', ?, ?, ?, ?)`,
        )
        .run(
          agentId,
          discussionId,
          kind,
          sessionId,
          `${PREFIX}${agentId}`,
          server.permissionMode,
          now,
          now,
        );
    })();
    this.mount(this.agentRow(agentId), { resume: false });
    return this.discussion(server.id, discussionId);
  }

  updateDiscussion(
    serverId: string,
    discussionId: string,
    patch: { name?: string; archived?: boolean },
  ): ServerDiscussionView {
    const row = this.discussionRow(serverId, discussionId);
    const name = patch.name === undefined ? row.name : patch.name.trim();
    if (!name || name.length > NAME_MAX)
      throw new AidHttpError(422, `nom de discussion vide ou de plus de ${NAME_MAX} caractères`);
    const archived = patch.archived === undefined ? row.archived : patch.archived ? 1 : 0;
    this.deps.db
      .prepare('UPDATE server_discussions SET name = ?, archived = ?, updated_at = ? WHERE id = ?')
      .run(name, archived, new Date().toISOString(), row.id);
    return this.discussion(serverId, discussionId);
  }

  /**
   * Arrête ses agents sur le serveur, puis supprime la discussion, ses agents et leurs fils. Un arrêt que le
   * serveur ne confirme pas (injoignable) refuse la suppression, sauf `force` (décision D.2).
   */
  async deleteDiscussion(serverId: string, discussionId: string, force = false): Promise<void> {
    const row = this.discussionRow(serverId, discussionId);
    this.closing.add(row.id);
    try {
      assertStopped(await this.stopAgentsOf([row.id]), force);
      this.deps.db.prepare('DELETE FROM server_discussions WHERE id = ?').run(row.id);
    } finally {
      this.closing.delete(row.id);
    }
  }

  /** Avant `DELETE /api/servers/:id` (revue R.1) : la cascade ne touche que la base, les relais s'arrêtent ici. */
  async forgetServer(serverId: string, force = false): Promise<void> {
    // levé par `released` une fois la réponse du DELETE partie : la ligne du serveur est alors effacée
    this.closing.add(serverId);
    const ids = (
      this.deps.db
        .prepare('SELECT id FROM server_discussions WHERE server_id = ?')
        .all(serverId) as { id: string }[]
    ).map((r) => r.id);
    assertStopped(await this.stopAgentsOf(ids), force);
  }

  released(serverId: string): void {
    this.closing.delete(serverId);
  }

  /** Arrête les agents de ces discussions ; rend le nombre de ceux dont le serveur n'a pas confirmé l'arrêt. */
  private async stopAgentsOf(discussionIds: string[]): Promise<number> {
    if (discussionIds.length === 0) return 0;
    let unconfirmed = 0;
    const rows = this.deps.db
      .prepare(
        `SELECT * FROM server_agents WHERE discussion_id IN (${discussionIds.map(() => '?').join(',')})`,
      )
      .all(...discussionIds) as AgentRow[];
    await Promise.all(
      rows.map(async (r) => {
        // une relance partie avant la suppression : on l'attend, son pilote est arrêté avec les autres
        await this.relaunching.get(r.id)?.catch(() => undefined);
        const live = this.live.get(r.id);
        let confirmed: boolean | null = null;
        if (live && !live.exited) {
          live.stopReason = 'deleted';
          // injoignable : l'arrêt n'est pas confirmé, l'appelant le dit (décision D.2)
          await live.driver.stop().catch(() => undefined);
          confirmed = live.driver.remoteChild?.stoppedOnServer ?? null;
        }
        if (confirmed === null) {
          // sans pilote vivant (en veille, ou sorti en erreur faute de lien) l'agent peut tourner encore ;
          // `stop` d'un relais inconnu ne fait rien
          confirmed = await this.stopRelay(this.agentRowOf(r)).then(
            (x) => x.code === 0,
            () => false,
          );
        }
        if (!confirmed) unconfirmed++;
        this.live.delete(r.id);
      }),
    );
    return unconfirmed;
  }

  // ---- pilotage

  /** Même message qu'au clavier d'un sujet (D59) : le pilote, puis une ligne du fil et `working`. */
  async input(agentId: string, raw: string): Promise<void> {
    const text = raw.replace(/\r\n?/g, '\n');
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text))
      throw new AidHttpError(422, 'caractère de contrôle refusé');
    if (!text.trim()) throw new AidHttpError(422, 'message vide');
    const row = this.agentRow(agentId);
    this.assertOpen(row);
    let live = this.live.get(agentId);
    if (live?.pending) throw new AidHttpError(409, 'répondre d’abord à la demande en cours');
    // en veille (redémarrage du daemon) ou fini : relancé par reprise de session, sous un relais neuf
    if (!live || live.exited) live = await this.relaunchOnce(row);
    try {
      live.driver.send(text);
    } catch {
      throw new AidHttpError(409, 'agent arrêté sur le serveur : message non transmis');
    }
    live.retry?.texts.push(text);
    this.record(live, { type: 'message', role: 'user', text });
    this.setStatus(agentId, 'working');
  }

  private assertOpen(row: AgentRow): void {
    const d = this.deps.db
      .prepare('SELECT server_id FROM server_discussions WHERE id = ?')
      .get(row.discussion_id) as { server_id: string } | undefined;
    if (!d || this.closing.has(row.discussion_id) || this.closing.has(d.server_id))
      throw new AidHttpError(409, 'discussion en cours de suppression');
  }

  interrupt(agentId: string): void {
    this.liveOr409(agentId).driver.interrupt();
  }

  answer(agentId: string, pendingId: string, answer: string): void {
    const live = this.liveOr409(agentId);
    const pending = live.pending;
    if (!pending || pending.id !== pendingId)
      throw new AidHttpError(409, 'cette demande n’est plus en cours');
    const option = pending.options.find((o) => o.answer === answer);
    if (!option) throw new AidHttpError(422, 'réponse inconnue pour cette demande');
    if (pending.confirm && pending.command && option.answer === 'always') {
      // « Toujours autoriser sur ce serveur » : la règle d'abord (une écriture en échec n'a rien autorisé), puis
      // cette demande, puis celles de la file que la règle couvre déjà
      this.addRule(live, pending.command);
      live.driver.answer(pendingId, 'yes');
      this.record(live, { type: 'request_answered', requestId: pendingId, answer: 'always' });
      const pattern = rulePattern(pending.command);
      try {
        for (const q of live.queued) {
          if (!q.confirm || !q.command || rulePattern(q.command) !== pattern) continue;
          // répondue d'abord, retirée ensuite : une réponse impossible la laisse en file, présentée plus tard
          live.driver.answer(q.id, 'yes');
          live.queued = live.queued.filter((r) => r !== q);
          this.record(live, {
            type: 'request_answered',
            requestId: q.id,
            answer: 'yes',
            auto: true,
          });
        }
      } catch {
        // lien perdu : les demandes restantes suivent leur cours (annulées par le pilote, ou présentées)
      }
      this.nextPending(live);
      return;
    }
    live.driver.answer(pendingId, option.answer);
    this.record(live, { type: 'request_answered', requestId: pendingId, answer: option.answer });
    this.nextPending(live);
  }

  private addRule(live: LiveRemote, command: string): void {
    const server = this.serverOf(this.agentRow(live.id));
    // déjà là (deux cartes pour la même commande) : la contrainte UNIQUE la garde une fois
    this.deps.db
      .prepare(
        'INSERT OR IGNORE INTO server_rules (id, server_id, cwd, pattern, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(`sr_${ulid()}`, server.id, live.cwd, rulePattern(command), new Date().toISOString());
  }

  private liveOr409(agentId: string): LiveRemote {
    this.agentRow(agentId);
    const live = this.live.get(agentId);
    if (!live || live.exited) throw new AidHttpError(409, 'agent arrêté sur le serveur');
    return live;
  }

  /** R.6 (§11.3) : « Reconnecter » après un échec de reprise, sans attendre le prochain message. */
  async reconnect(agentId: string): Promise<void> {
    const row = this.agentRow(agentId);
    this.assertOpen(row);
    const live = this.live.get(agentId);
    if ((!live || live.exited) && (await this.reattach(row))) return;
    if (!live || live.exited) await this.relaunchOnce(row);
  }

  /**
   * Chantier 19, S.4 (DS3) : un claude fini faute de lien dont l'agent tourne encore sur le serveur est rattaché à
   * son offset, comme au démarrage du daemon — le relancer tuerait le tour en cours. Faux s'il n'y a rien à
   * rattacher (agent arrêté, serveur muet) : la relance reprend la main.
   */
  private async reattach(row: AgentRow): Promise<boolean> {
    if (row.kind !== 'claude' || !row.session_id) return false;
    const r = await remoteExec(this.serverOf(row), relayAlive(relayOf(row)), {
      ...this.deps.transport,
      timeoutMs: 10_000,
    }).catch(() => null);
    let state: string | null = null;
    try {
      state = r?.code === 0 ? parseAlive(r.stdout).state : null;
    } catch {
      state = null;
    }
    if (state !== 'vivant') return false;
    // un double clic : le premier a déjà rattaché
    const other = this.live.get(row.id);
    if (other && !other.exited) return true;
    const fresh = this.agentRow(row.id);
    this.live.delete(row.id);
    this.mount(fresh, { resume: this.hasTurn(row.id), offset: fresh.out_offset });
    this.setStatus(row.id, 'idle');
    return true;
  }

  // ---- composer (R.6) : repères, mode, modèle et effort, comme pour un agent local

  /** Repère (A.7) : seul un message utilisateur du fil se marque. */
  mark(agentId: string, seq: number, marked: boolean): void {
    this.agentRow(agentId);
    const row = this.deps.db
      .prepare('SELECT kind, payload FROM server_agent_messages WHERE agent_id = ? AND seq = ?')
      .get(agentId, seq) as { kind: string; payload: string } | undefined;
    if (!row) throw new AidHttpError(404, 'message inconnu');
    let role: string | undefined;
    if (row.kind === 'message') {
      try {
        role = (JSON.parse(row.payload) as { role?: string }).role;
      } catch {
        throw new AidHttpError(422, 'message illisible');
      }
    }
    if (role !== 'user')
      throw new AidHttpError(422, 'seul un message utilisateur peut être marqué');
    this.deps.db
      .prepare('UPDATE server_agent_messages SET marked = ? WHERE agent_id = ? AND seq = ?')
      .run(marked ? 1 : 0, agentId, seq);
  }

  /** D71 : les modes sont ceux qu'un serveur accepte ; le catalogue codex vient d'un pilote vivant. */
  options(agentId: string): AgentOptions {
    const row = this.agentRow(agentId);
    for (const live of this.live.values()) {
      const catalog = live.driver.catalog();
      if (catalog.length) this.codexCatalog = catalog;
    }
    // le catalogue de cet agent d'abord : deux serveurs peuvent avoir deux versions de codex (revue R.6)
    const propre = this.live.get(agentId)?.driver.catalog() ?? [];
    const options = agentOptions(row.kind, propre.length ? propre : this.codexCatalog);
    const sansAuto = claudeSansAuto(row.kind, this.serverOf(row));
    return {
      ...options,
      modes: options.modes.filter(
        (m) => SERVER_PERMISSION_MODES.includes(m.id) && !(sansAuto && m.id === 'auto'),
      ),
    };
  }

  /** Écrit sur l'agent, appliqué au pilote vivant ; un agent arrêté le prend à sa relance. */
  setSettings(agentId: string, patch: Partial<AgentSettings>): AgentSettings {
    const row = this.agentRow(agentId);
    const next: AgentSettings = {
      mode: patch.mode ?? row.permission_mode,
      model: patch.model === undefined ? row.model : patch.model,
      effort: patch.effort === undefined ? row.effort : patch.effort,
    };
    const options = this.options(agentId);
    if (!options.modes.some((m) => m.id === next.mode))
      throw new AidHttpError(422, `mode inconnu pour ${row.kind} : ${next.mode}`);
    // seuls les champs envoyés sont validés : un modèle déjà en place reste valable quand le catalogue codex
    // n'est pas encore connu (agent en veille après un redémarrage du daemon, revue R.6)
    const model = next.model === null ? undefined : options.models.find((m) => m.id === next.model);
    if (patch.model !== undefined && next.model !== null && !model)
      throw new AidHttpError(422, `modèle inconnu pour ${row.kind} : ${next.model}`);
    const efforts = model?.efforts.length ? model.efforts : options.efforts;
    if (patch.effort !== undefined && next.effort !== null && !efforts.includes(next.effort))
      throw new AidHttpError(422, `effort inconnu : ${next.effort}`);
    this.deps.db
      .prepare(
        'UPDATE server_agents SET permission_mode = ?, model = ?, effort = ?, updated_at = ? WHERE id = ?',
      )
      .run(next.mode, next.model, next.effort, new Date().toISOString(), agentId);
    const live = this.live.get(agentId);
    if (live && !live.exited) {
      // R.5 : codex sous confirmation reste en `untrusted` ; son mode auto devient le tri du daemon
      const driverSettings = { ...next };
      if (live.confirm && row.kind === 'codex') {
        live.confirm.autoApprove = next.mode === 'auto';
        if (live.confirm.autoApprove) driverSettings.mode = 'default';
      }
      live.driver.configure(driverSettings);
    }
    return next;
  }

  // ---- cycle de vie

  /**
   * Au démarrage du daemon : chaque agent claude non fini est rattaché à son relais, à l'offset écrit avec la
   * dernière ligne du fil. Un agent codex ne l'est pas : son pilote referait la poignée de main JSON-RPC sur un
   * process qui l'a déjà faite. Son relais est arrêté au mieux ; le prochain message le relance par
   * `thread/resume` sous un relais neuf.
   */
  reattachAll(): void {
    const rows = this.deps.db
      .prepare(
        `SELECT * FROM server_agents WHERE status NOT IN (${FINISHED.map(() => '?').join(',')})`,
      )
      .all(...FINISHED) as AgentRow[];
    for (const row of rows) {
      try {
        if (row.kind === 'claude' && row.session_id) {
          const live = this.mount(row, { resume: this.hasTurn(row.id), offset: row.out_offset });
          // revue R.4 : la demande en attente est perdue avec la mémoire du daemon (le pilote ne connaît plus
          // son id) ; le tour, bloqué sur elle, est interrompu plutôt que laissé en attente sans fin
          if (row.status === 'needs_input') {
            live.driver.interrupt();
            this.setStatus(row.id, 'working');
          }
        } else {
          void this.stopRelay(row).catch(() => undefined);
          this.setStatus(row.id, 'idle');
        }
      } catch {
        // une ligne illisible n'empêche ni le daemon de démarrer ni les autres agents d'être rattachés
      }
    }
  }

  /** Arrêt du daemon : les liens se ferment, les agents continuent sur leurs serveurs (D73). */
  detachAll(): void {
    // retirés d'abord : un `exit` émis pendant le détachement ne doit pas marquer l'agent fini
    const all = [...this.live.values()];
    this.live.clear();
    for (const live of all) live.driver.detach();
  }

  private relaunchOnce(row: AgentRow): Promise<LiveRemote> {
    let p = this.relaunching.get(row.id);
    if (!p) {
      p = this.relaunch(row).finally(() => this.relaunching.delete(row.id));
      this.relaunching.set(row.id, p);
    }
    return p;
  }

  /**
   * L'ancien relais est arrêté d'abord, et attendu : sinon deux agents reprendraient la même session, et un
   * arrêt échoué perdrait de vue un agent dont `tmux_session` est la seule trace.
   */
  private async relaunch(row: AgentRow, resume?: boolean): Promise<LiveRemote> {
    const res = await this.stopRelay(row).catch(() => null);
    if (res?.code !== 0)
      throw new AidHttpError(502, 'serveur injoignable : l’agent précédent n’a pas pu être arrêté');
    const fresh = this.agentRow(row.id);
    this.assertOpen(fresh);
    this.live.delete(row.id);
    const relayId = `${row.id}-${ulid()}`;
    this.deps.db
      .prepare(
        'UPDATE server_agents SET tmux_session = ?, out_offset = 0, updated_at = ? WHERE id = ?',
      )
      .run(`${PREFIX}${relayId}`, new Date().toISOString(), row.id);
    const guess = !!fresh.session_id && this.hasTurn(row.id);
    const live = this.mount(this.agentRow(row.id), { resume: resume ?? guess });
    if (resume === undefined && row.kind === 'claude' && fresh.session_id)
      live.retry = { resume: guess, texts: [] };
    return live;
  }

  /** S.5 : le pilote relancé est remplacé par un autre, lancé avec le critère de reprise inverse. */
  private retryInverse(live: LiveRemote, retry: { resume: boolean; texts: string[] }): void {
    live.exited = true;
    const p = this.relaunch(this.agentRow(live.id), !retry.resume)
      .then((next) => {
        for (const text of retry.texts) next.driver.send(text);
        return next;
      })
      .finally(() => this.relaunching.delete(live.id));
    this.relaunching.set(live.id, p);
    p.catch(() => this.setStatus(live.id, 'error'));
  }

  /** Une session n'existe chez l'agent qu'après un tour : avant, `--resume` échouerait en boucle (revue R.4). */
  private hasTurn(agentId: string): boolean {
    return !!this.deps.db
      .prepare(
        "SELECT 1 FROM server_agent_messages WHERE agent_id = ? AND kind = 'turn_end' LIMIT 1",
      )
      .get(agentId);
  }

  private agentRowOf(r: AgentRow): AgentRow {
    return (
      (this.deps.db.prepare('SELECT * FROM server_agents WHERE id = ?').get(r.id) as AgentRow) ?? r
    );
  }

  // async : un serveur introuvable devient un rejet, attrapé par l'appelant, pas une exception synchrone
  private async stopRelay(row: AgentRow) {
    const server = this.serverOf(row);
    return remoteExec(server, relayStop(relayOf(row)), {
      ...this.deps.transport,
      timeoutMs: 10_000,
    });
  }

  private serverOf(row: AgentRow): Server {
    const d = this.deps.db
      .prepare('SELECT server_id FROM server_discussions WHERE id = ?')
      .get(row.discussion_id) as { server_id: string } | undefined;
    const server = d && getServer(this.deps.db, d.server_id);
    if (!server) throw new AidHttpError(404, 'serveur de cet agent introuvable');
    return server;
  }

  private mount(row: AgentRow, o: { resume: boolean; offset?: number }): LiveRemote {
    const server = this.serverOf(row);
    const discussion = this.deps.db
      .prepare('SELECT cwd FROM server_discussions WHERE id = ?')
      .get(row.discussion_id) as { cwd: string };
    const bin = this.deps.bins?.[row.kind] ?? row.kind;
    const settings: AgentSettings = {
      mode: row.permission_mode,
      model: row.model,
      effort: row.effort,
    };
    const confirm: Confirm | null = server.confirmDestructive
      ? { server: server.name, autoApprove: row.kind === 'codex' && settings.mode === 'auto' }
      : null;
    // codex en auto passerait en `never` : plus rien ne serait demandé, destructif compris
    if (confirm?.autoApprove) settings.mode = 'default';
    // claude en `auto` (mode du serveur, ou lancé avant que la confirmation soit activée) : ramené à `default`
    const ramene = claudeSansAuto(row.kind, server) && settings.mode === 'auto';
    // le pilote part du mode du process (rattaché, il tourne en `auto`), puis reçoit `default` au démarrage
    if (ramene) {
      this.deps.db
        .prepare('UPDATE server_agents SET permission_mode = ? WHERE id = ?')
        .run('default', row.id);
    }
    const confirmOpts = !confirm
      ? {}
      : row.kind === 'claude'
        ? { extraArgs: ['--settings', claudeConfirmSettings()] }
        : { approvalPolicy: 'untrusted' };
    const driver = new RemoteDriver({
      server,
      transport: this.deps.transport,
      relayId: relayOf(row),
      offset: o.offset,
      sessionId: row.session_id ?? '',
      resume: o.resume,
      settings,
      delaysMs: this.deps.delaysMs,
      create: (c): ConversationDriver => {
        // `cwd` est celui du serveur ; l'environnement du daemon n'y part pas (D76)
        const opts = { bin, cwd: discussion.cwd, env: {}, ...c, ...confirmOpts };
        return row.kind === 'claude' ? new ClaudeDriver(opts) : new CodexDriver(opts);
      },
    });
    const seq = (
      this.deps.db
        .prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM server_agent_messages WHERE agent_id = ?')
        .get(row.id) as { n: number }
    ).n;
    const live: LiveRemote = {
      id: row.id,
      discussionId: row.discussion_id,
      driver,
      seq,
      exited: false,
      exit: null,
      pending: null,
      queued: [],
      confirm,
      cwd: discussion.cwd,
      subscribe: (cb) => {
        const set = this.subscribers.get(row.id) ?? new Set();
        set.add(cb);
        this.subscribers.set(row.id, set);
        return () => {
          set.delete(cb);
          if (set.size === 0 && this.subscribers.get(row.id) === set)
            this.subscribers.delete(row.id);
        };
      },
    };
    this.live.set(row.id, live);
    driver.onEvent((ev) => {
      // pilote remplacé par une relance : l'ancien n'écrit plus rien
      if (this.live.get(row.id) !== live) return;
      try {
        this.onEvent(live, ev);
        // `thinking` n'est pas journalisé (D65) mais se diffuse ; le reste l'a été par `record`
        if (ev.type === 'thinking') this.notify(live.id, ev);
      } catch {
        // une écriture en base qui échoue ne remonte pas dans la lecture de la sortie du relais
      }
    });
    driver.start();
    // rattaché à un process lancé en `auto` : le changement de mode lui est envoyé, il demandera tout
    if (ramene) driver.configure({ ...settings, mode: 'default' });
    return live;
  }

  private onEvent(live: LiveRemote, ev: ConversationEvent): void {
    if (live.retry) {
      // S.5 : refus au démarrage, avant tout mot de l'agent — retenté une fois, la fin n'entre pas au fil
      if (ev.type === 'exit' && ev.code !== 0 && !live.stopReason) {
        const retry = live.retry;
        live.retry = undefined;
        return this.retryInverse(live, retry);
      }
      if (ev.type !== 'exit' && ev.type !== 'connection_lost' && ev.type !== 'connection_resumed')
        live.retry = undefined;
    }
    if (ev.type === 'request' && live.confirm && !ev.request.confirm) {
      const screened = this.screen(live, live.confirm, ev.request);
      if (screened !== ev.request) {
        if (screened) this.onEvent(live, { type: 'request', request: screened });
        return;
      }
    }
    if (ev.type !== 'thinking') this.record(live, ev);
    switch (ev.type) {
      case 'session':
        this.deps.db
          .prepare('UPDATE server_agents SET session_id = ?, updated_at = ? WHERE id = ?')
          .run(ev.sessionId, new Date().toISOString(), live.id);
        break;
      case 'request':
        if (live.pending) live.queued.push(ev.request);
        else live.pending = ev.request;
        this.setStatus(live.id, 'needs_input');
        break;
      case 'request_cancelled':
        live.queued = live.queued.filter((r) => r.id !== ev.requestId);
        if (live.pending?.id === ev.requestId) this.nextPending(live);
        break;
      case 'turn_end':
        live.pending = null;
        live.queued = [];
        this.setStatus(live.id, 'idle');
        break;
      case 'exit': {
        live.exited = true;
        live.pending = null;
        live.queued = [];
        live.exit = { exitCode: ev.code, signal: ev.signal, reason: live.stopReason ?? 'exit' };
        const status: AgentStatus = live.stopReason ? 'stopped' : ev.code === 0 ? 'done' : 'error';
        this.setStatus(live.id, status);
        break;
      }
      default:
        break;
    }
  }

  /**
   * R.5 (D77) : une demande destructive devient une carte de confirmation, ou passe seule si une règle du serveur
   * la couvre (commande exacte). Rend la demande à présenter, ou `null` quand le daemon a déjà répondu.
   */
  private screen(
    live: LiveRemote,
    confirm: Confirm,
    request: PendingRequest,
  ): PendingRequest | null {
    const command = request.command;
    // sans commande (fichiers…) : jamais acceptée d'office, l'opérateur la voit (revue R.5)
    if (!command) return request;
    if (!(request.byRule || isDestructive(command))) {
      if (!confirm.autoApprove) return request;
      try {
        // codex en auto : ce que `never` aurait laissé passer ; le fil en garde l'exécution (`tool_start`)
        live.driver.answer(request.id, 'yes');
        return null;
      } catch {
        return request;
      }
    }
    const shown: PendingRequest = {
      ...request,
      options: CONFIRM_OPTIONS,
      confirm: { server: confirm.server },
    };
    // règle illisible ou réponse impossible : la carte est présentée, rien ne passe en silence
    try {
      const server = this.serverOf(this.agentRow(live.id));
      const covered = (r: ServerRule) => r.cwd === live.cwd && r.pattern === rulePattern(command);
      if (!server.rules.some(covered)) return shown;
      live.driver.answer(request.id, 'yes');
    } catch {
      return shown;
    }
    this.record(live, { type: 'request', request: shown });
    this.record(live, {
      type: 'request_answered',
      requestId: request.id,
      answer: 'yes',
      auto: true,
    });
    return null;
  }

  private nextPending(live: LiveRemote): void {
    live.pending = live.queued.shift() ?? null;
    this.setStatus(live.id, live.pending ? 'needs_input' : 'working');
  }

  /** Une ligne du fil et l'offset sûr du relais, ensemble : un rattachement repart juste après cette ligne. */
  private record(live: LiveRemote, ev: ConversationEvent): void {
    const seq = ++live.seq;
    const now = new Date().toISOString();
    try {
      this.deps.db.transaction(() => {
        this.deps.db
          .prepare(
            'INSERT INTO server_agent_messages (agent_id, seq, kind, payload, at) VALUES (?, ?, ?, ?, ?)',
          )
          .run(live.id, seq, ev.type, JSON.stringify(ev), now);
        this.deps.db
          .prepare('UPDATE server_agents SET out_offset = ?, updated_at = ? WHERE id = ?')
          .run(live.driver.committedOffset, now, live.id);
      })();
    } catch (err) {
      // discussion supprimée pendant que l'agent parlait encore : rien à écrire
      if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_FOREIGNKEY') return;
      // autre échec : la ligne n'est pas au fil et l'offset n'a pas avancé. Le lien est fermé pour que la
      // suite ne fasse pas avancer l'offset par-dessus ; le prochain message relance l'agent (revue R.4)
      if (this.live.get(live.id) === live) this.live.delete(live.id);
      live.driver.detach();
      return;
    }
    this.notify(live.id, ev);
  }

  private notify(agentId: string, ev: ConversationEvent): void {
    for (const cb of this.subscribers.get(agentId) ?? []) {
      try {
        cb(ev);
      } catch {
        // un abonné en échec ne prive pas les autres de l'événement
      }
    }
  }

  private setStatus(agentId: string, status: AgentStatus): void {
    this.deps.db
      .prepare('UPDATE server_agents SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, new Date().toISOString(), agentId);
  }
}
