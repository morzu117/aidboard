import { randomUUID } from 'node:crypto';
import { monotonicFactory } from 'ulid';
import type { AgentSettings, PermissionMode } from '../../shared/agentSettings.js';
import type {
  AgentStatus,
  PendingRequest,
  Server,
  ServerAgent,
  ServerDiscussion,
} from '../../shared/model.js';
import { ClaudeDriver } from '../conversation/claude.js';
import { CodexDriver } from '../conversation/codex.js';
import type { ConversationDriver, ConversationEvent } from '../conversation/driver.js';
import type { Db } from '../db.js';
import { AidHttpError } from '../errors.js';
import { CONFIRM_OPTIONS, claudeConfirmSettings, isDestructive, rulePattern } from './confirm.js';
import { RemoteDriver } from './driver.js';
import { relayStop } from './relay.js';
import { getServer } from './servers.js';
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
  subscribe(cb: (ev: ConversationEvent) => void): () => void;
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

  /** Arrête ses agents sur le serveur (au mieux), puis supprime la discussion, ses agents et leurs fils. */
  async deleteDiscussion(serverId: string, discussionId: string): Promise<void> {
    const row = this.discussionRow(serverId, discussionId);
    this.closing.add(row.id);
    try {
      await this.stopAgentsOf([row.id]);
      this.deps.db.prepare('DELETE FROM server_discussions WHERE id = ?').run(row.id);
    } finally {
      this.closing.delete(row.id);
    }
  }

  /** Avant `DELETE /api/servers/:id` (revue R.1) : la cascade ne touche que la base, les relais s'arrêtent ici. */
  async forgetServer(serverId: string): Promise<void> {
    // levé par `released` une fois la réponse du DELETE partie : la ligne du serveur est alors effacée
    this.closing.add(serverId);
    const ids = (
      this.deps.db
        .prepare('SELECT id FROM server_discussions WHERE server_id = ?')
        .all(serverId) as { id: string }[]
    ).map((r) => r.id);
    await this.stopAgentsOf(ids);
  }

  released(serverId: string): void {
    this.closing.delete(serverId);
  }

  private async stopAgentsOf(discussionIds: string[]): Promise<void> {
    if (discussionIds.length === 0) return;
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
        if (live && !live.exited) {
          live.stopReason = 'deleted';
          // au mieux : un serveur injoignable n'empêche pas de supprimer
          await live.driver.stop().catch(() => undefined);
        } else {
          // sans pilote vivant (en veille, ou sorti en erreur faute de lien) l'agent peut tourner encore ;
          // `stop` d'un relais inconnu ne fait rien
          await this.stopRelay(this.agentRowOf(r)).catch(() => undefined);
        }
        this.live.delete(r.id);
      }),
    );
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
        'INSERT OR IGNORE INTO server_rules (id, server_id, pattern, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(`sr_${ulid()}`, server.id, rulePattern(command), new Date().toISOString());
  }

  private liveOr409(agentId: string): LiveRemote {
    this.agentRow(agentId);
    const live = this.live.get(agentId);
    if (!live || live.exited) throw new AidHttpError(409, 'agent arrêté sur le serveur');
    return live;
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
  private async relaunch(row: AgentRow): Promise<LiveRemote> {
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
    return this.mount(this.agentRow(row.id), {
      resume: !!fresh.session_id && this.hasTurn(row.id),
    });
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
    return live;
  }

  private onEvent(live: LiveRemote, ev: ConversationEvent): void {
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
      if (!server.rules.some((r) => r.pattern === rulePattern(command))) return shown;
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
