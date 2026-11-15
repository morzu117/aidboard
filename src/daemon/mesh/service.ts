import { envSwarph } from './env.js';
import { closeSync, openSync, readSync } from 'node:fs';
import type { MeshConfig } from '../config.js';
import type { Db } from '../db.js';
import type { EventStore } from '../events/store.js';
import type { MeshDm, MeshMonitor, MeshState, MeshTailscale } from '../../shared/model.js';
import { type MeshExec, meshExec } from './exec.js';
import { InboxFollower } from './inbox.js';
import { meshPaths } from './paths.js';
import { tailscaleState } from './tailscale.js';

export interface MeshServiceDeps {
  config: MeshConfig;
  nom?: string;
  home: string;
  db: Db;
  store: EventStore;
  log: (line: string) => void;
  /** tests : faux binaires par le PATH ou un exécuteur substitué */
  exec?: MeshExec;
  tailscale?: (bin: string) => Promise<MeshTailscale>;
  refreshMs?: number;
  pollMs?: number;
  timeoutMs?: number;
  now?: () => string;
}

/** `swarph monitor status --json` : ce qu'on en garde. */
export function parseMonitorStatus(stdout: string): {
  monitor: MeshMonitor;
  pending: number;
  superviseur: string | null;
} {
  let parsed: {
    running?: unknown;
    pidfile_status?: unknown;
    sinks?: unknown;
    supervisor?: unknown;
  };
  try {
    parsed = JSON.parse(stdout) as typeof parsed;
  } catch {
    return { monitor: 'stopped', pending: 0, superviseur: null };
  }
  const candidat = typeof parsed?.supervisor === 'string' ? parsed.supervisor.trim() : '';
  const superviseur =
    candidat.length > 0 && candidat.length <= 200 && !/\p{Cc}/u.test(parsed.supervisor as string)
      ? candidat
      : null;
  const sinks = Array.isArray(parsed.sinks) ? (parsed.sinks as { pending?: unknown }[]) : [];
  const pending = sinks.reduce(
    (n, s) => n + (Number.isInteger(s?.pending) ? (s.pending as number) : 0),
    0,
  );
  const monitor: MeshMonitor =
    parsed.running === true ? 'running' : parsed.pidfile_status === 'stale' ? 'stale' : 'stopped';
  return { monitor, pending, superviseur };
}

/**
 * Connecter, suivre, déconnecter (12.3, D35/D37). A-I-D ne parle jamais au gateway : il lance le monitor
 * swarph (détaché, idempotent), lit `monitor status --json` et suit `inbox.log`. Tailscale est lu toujours,
 * monté ou descendu seulement si `tailscale.manage` vaut true — et descendu seulement par qui l'a monté.
 */
export class MeshService {
  private state: MeshState;
  private follower: InboxFollower | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private tailscaleUpByUs = false;
  private busy: Promise<void> = Promise.resolve();
  /** D99 bis : heure de la dernière lecture de `monitor status`, tenue en mémoire seulement */
  private checked: string | null = null;
  private readonly paths;

  constructor(private readonly deps: MeshServiceDeps) {
    this.paths = meshPaths(deps.config, deps.home);
    this.state = {
      ecritures: !!deps.config.proxySocket && !deps.config.proxyLectureSeule,
      proxyConfigure: !!deps.config.proxySocket,
      connected: false,
      tailscale: 'absent',
      monitor: 'absent',
      superviseur: null,
      pending: 0,
      since: null,
      cell: deps.config.cell,
    };
  }

  current(): MeshState {
    return { ...this.state };
  }

  /** D99 bis : quand `monitor status` a été lu pour la dernière fois, pour dire l'âge de l'état affiché. */
  checkedAt(): string | null {
    return this.checked;
  }

  /**
   * Lecture du board (chantier 24, D92) : même environnement et même délai que les autres appels, mais
   * hors de la file `serial()` — une lecture de 3 s ne retarde ni `connect` ni `refresh`. Les arguments
   * viennent de `BoardReader`, qui n'en construit que six formes (D93).
   */
  read(args: string[], options?: { env?: Record<string, string>; unset?: string[] }) {
    if (options) {
      const env = this.env();
      for (const nom of options.unset ?? []) delete env[nom];
      return (this.deps.exec ?? meshExec)(this.deps.config.bin, args, {
        env,
        timeoutMs: this.deps.timeoutMs ?? 30_000,
      });
    }
    return this.run(this.deps.config.bin, args);
  }

  get inboxLog(): string {
    return this.paths.inboxLog;
  }

  /** l'UI en a besoin pour expliquer pourquoi « rejoindre » est impossible quand Tailscale est arrêté (12.5) */
  get tailscaleManage(): boolean {
    return this.deps.config.tailscale.manage;
  }

  /** La boîte projetée (12.4) : les plus récents d'abord, bornée. */
  inbox(limit = 200): MeshDm[] {
    const rows = this.deps.db
      .prepare('SELECT * FROM mesh_inbox WHERE mesh = ? ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(this.deps.nom ?? 'principal', limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as number,
      threadId: (r.thread_id as string | null) ?? null,
      from: r.from_node as string,
      to: r.to_node as string,
      kind: r.kind as MeshDm['kind'],
      content: r.content as string,
      createdAt: r.created_at as string,
      replyTo: (r.reply_to as number | null) ?? null,
      obligationId: (r.obligation_id as string | null) ?? null,
      seenAt: (r.seen_at as string | null) ?? null,
      decidedAt: (r.decided_at as string | null) ?? null,
    }));
  }

  /**
   * « Vu » (12.4) : une marque locale de l'humain dans A-I-D, jamais le `read_at` du gateway. Idempotent :
   * la première marque reste. Rend null si le DM est inconnu. Écriture directe (pas un événement) : c'est
   * un signet d'affichage, pas un fait du mesh — il ne survit pas à une reconstruction depuis le journal.
   */
  markSeen(id: number): { id: number; seenAt: string } | null {
    const row = this.deps.db
      .prepare('SELECT seen_at FROM mesh_inbox WHERE mesh = ? AND id = ?')
      .get(this.deps.nom ?? 'principal', id) as { seen_at: string | null } | undefined;
    if (!row) return null;
    if (row.seen_at) return { id, seenAt: row.seen_at };
    const seenAt = this.now();
    this.deps.db
      .prepare('UPDATE mesh_inbox SET seen_at = ? WHERE mesh = ? AND id = ?')
      .run(seenAt, this.deps.nom ?? 'principal', id);
    return { id, seenAt };
  }

  /**
   * Chantier 28 (D137) : « En faire une décision ». Même nature que « Vu » : une marque locale, idempotente, hors
   * journal ; le DM reste une donnée du pair. Rend null si le DM est inconnu.
   */
  markDecision(id: number): { id: number; decidedAt: string } | null {
    const row = this.deps.db
      .prepare('SELECT decided_at FROM mesh_inbox WHERE mesh = ? AND id = ?')
      .get(this.deps.nom ?? 'principal', id) as { decided_at: string | null } | undefined;
    if (!row) return null;
    if (row.decided_at) return { id, decidedAt: row.decided_at };
    const decidedAt = this.now();
    this.deps.db
      .prepare('UPDATE mesh_inbox SET decided_at = ? WHERE mesh = ? AND id = ?')
      .run(decidedAt, this.deps.nom ?? 'principal', id);
    return { id, decidedAt };
  }

  /**
   * Au démarrage du daemon : un seul `monitor status --json` décide de l'état affiché. Un monitor détaché
   * survit au daemon — s'il tourne, on reprend le suivi sans le relancer ; sinon rien (pas de connexion
   * automatique). Le `since` persisté est repris si l'état `connected` n'a pas changé.
   */
  async init(): Promise<void> {
    await this.serial(async () => {
      const persisted = this.readPersisted();
      const tailscale = await this.tailscale();
      const { monitor, pending, superviseur } = await this.monitorStatus();
      const connected = monitor === 'running' || monitor === 'proxy';
      if (connected) this.startFollower();
      if (this.deps.config.inboxLog) this.startRefresh();
      this.publish({
        connected,
        tailscale,
        monitor,
        superviseur,
        pending,
        since: persisted?.connected === connected ? (persisted.since ?? this.now()) : this.now(),
      });
    });
  }

  /** Rend l'état obtenu ; `connected` reste false si Tailscale ou le monitor manquent (la raison est dans l'état). */
  async connect(): Promise<MeshState> {
    await this.serial(async () => {
      const { config } = this.deps;
      let tailscale = await this.tailscale();
      if (tailscale === 'stopped' && config.tailscale.manage) {
        const up = await this.run(config.tailscale.bin, ['up']);
        if (up.ok) this.tailscaleUpByUs = true;
        else this.deps.log(`mesh : tailscale up a échoué : ${up.stderr.trim()}`);
        tailscale = await this.tailscale();
      }
      if (tailscale !== 'running') {
        this.publish({ connected: false, tailscale, since: this.sinceIf(false) });
        return;
      }
      if (config.inboxLog) {
        const { monitor, pending, superviseur } = await this.monitorStatus();
        const connected = monitor === 'proxy';
        if (connected) this.startFollower();
        this.startRefresh();
        this.publish({
          connected,
          tailscale,
          monitor,
          pending,
          superviseur,
          since: this.sinceIf(connected),
        });
        return;
      }
      const statut = await this.monitorStatus();
      if (statut.monitor === 'running' && statut.superviseur !== null) {
        this.startFollower();
        this.startRefresh();
        this.publish({ ...statut, connected: true, tailscale, since: this.sinceIf(true) });
        return;
      }
      const start = await this.run(config.bin, [
        'monitor',
        'start',
        '--as',
        config.cell,
        '--deliver',
        'pull',
      ]);
      if (!start.ok) {
        this.deps.log(
          `mesh : swarph monitor start a échoué${start.spawnErrorCode ? ` (${start.spawnErrorCode})` : ''} : ${start.stderr.trim()}`,
        );
        this.publish({
          connected: false,
          tailscale,
          superviseur: null,
          monitor: start.spawnErrorCode === 'ENOENT' ? 'absent' : 'stopped',
          since: this.sinceIf(false),
        });
        return;
      }
      const { monitor, pending, superviseur } = await this.monitorStatus();
      const connected = monitor === 'running';
      if (connected) {
        this.startFollower();
        this.startRefresh();
      }
      this.publish({
        connected,
        tailscale,
        monitor,
        pending,
        superviseur,
        since: this.sinceIf(connected),
      });
    });
    return this.current();
  }

  async disconnect(): Promise<MeshState> {
    await this.serial(async () => {
      const { config } = this.deps;
      this.stopFollower();
      this.stopRefresh();
      if (!config.inboxLog) {
        const statut = await this.monitorStatus();
        if (statut.monitor !== 'running' || statut.superviseur === null) {
          const stop = await this.run(config.bin, ['monitor', 'stop', '--as', config.cell]);
          if (!stop.ok)
            this.deps.log(`mesh : swarph monitor stop a échoué : ${stop.stderr.trim()}`);
        }
      }
      if (config.tailscale.manage && this.tailscaleUpByUs) {
        const down = await this.run(config.tailscale.bin, ['down']);
        if (!down.ok) this.deps.log(`mesh : tailscale down a échoué : ${down.stderr.trim()}`);
        this.tailscaleUpByUs = false;
      }
      const tailscale = await this.tailscale();
      const { monitor, pending, superviseur } = await this.monitorStatus();
      this.publish({
        connected: false,
        tailscale,
        monitor,
        pending,
        superviseur,
        since: this.sinceIf(false),
      });
    });
    return this.current();
  }

  /** Toutes les 30 s pendant la connexion : `monitor status --json` ⇒ `pending`, `monitor`, et `mesh.state` si changement. */
  async refresh(): Promise<MeshState> {
    await this.serial(async () => {
      const tailscale = await this.tailscale();
      const { monitor, pending, superviseur } = await this.monitorStatus();
      const connected = this.deps.config.inboxLog
        ? this.refreshTimer !== null && monitor === 'proxy' && tailscale === 'running'
        : this.state.connected && monitor === 'running' && tailscale === 'running';
      if (connected && this.deps.config.inboxLog) this.startFollower();
      if (this.state.connected && !connected) {
        this.stopFollower();
        if (!this.deps.config.inboxLog) this.stopRefresh();
      }
      this.publish({
        connected,
        tailscale,
        monitor,
        pending,
        superviseur,
        since: this.sinceIf(connected),
      });
    });
    return this.current();
  }

  /** Arrêt du daemon : on cesse de suivre, on ne touche ni au monitor ni à Tailscale (ils survivent au daemon). */
  dispose(): void {
    this.stopFollower();
    this.stopRefresh();
  }

  /** Lecture forcée d'`inbox.log` (tests, ou après un réveil) ; rend le nombre de DM émis. */
  tick(): number {
    return this.follower?.tick() ?? 0;
  }

  private serial(task: () => Promise<void>): Promise<void> {
    const next = this.busy.then(task, task);
    this.busy = next.catch((err) => this.deps.log(`mesh : ${(err as Error).message}`));
    return this.busy;
  }

  private now(): string {
    return this.deps.now?.() ?? new Date().toISOString();
  }

  private sinceIf(connected: boolean): string | null {
    const unchanged = this.state.connected === connected && this.state.since !== null;
    return unchanged ? this.state.since : this.now();
  }

  private env(): NodeJS.ProcessEnv {
    return envSwarph({ ...this.deps.config, home: this.deps.config.home ?? this.deps.home });
  }

  private run(bin: string, args: string[]) {
    return (this.deps.exec ?? meshExec)(bin, args, {
      env:
        bin === this.deps.config.bin
          ? this.env()
          : {
              ...process.env,
              SWARPH_STATE: this.paths.stateRoot,
              ...(this.deps.config.gateway && { MESH_GATEWAY_URL: this.deps.config.gateway }),
            },
      timeoutMs: this.deps.timeoutMs ?? 30_000,
    });
  }

  // même exécuteur que swarph (environnement, délai, faux binaires en test)
  private tailscale(): Promise<MeshTailscale> {
    const bin = this.deps.config.tailscale.bin;
    if (this.deps.tailscale) return this.deps.tailscale(bin);
    return tailscaleState(bin, async (b, args) => {
      const r = await this.run(b, args);
      return { stdout: r.stdout, code: r.ok ? null : (r.spawnErrorCode ?? 'ERR') };
    });
  }

  private async monitorStatus(): Promise<{
    monitor: MeshMonitor;
    pending: number;
    superviseur: string | null;
  }> {
    if (this.deps.config.inboxLog) {
      this.checked = this.now();
      this.deps.store.emitEphemeral({
        kind: 'ephemeral',
        type: 'mesh.checked',
        mesh: this.deps.nom ?? 'principal',
        checkedAt: this.checked,
      });
      let fichier: number | undefined;
      try {
        fichier = openSync(this.paths.inboxLog, 'r');
        readSync(fichier, Buffer.alloc(1), 0, 1, 0);
        return { monitor: 'proxy', pending: 0, superviseur: null };
      } catch (erreur) {
        return {
          monitor: (erreur as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'stopped',
          pending: 0,
          superviseur: null,
        };
      } finally {
        if (fichier !== undefined) closeSync(fichier);
      }
    }
    const r = await this.run(this.deps.config.bin, [
      'monitor',
      'status',
      '--json',
      '--as',
      this.deps.config.cell,
    ]);
    // D99 bis : relayé aux sockets sans être stocké, `mesh.state` reste émis au seul changement
    this.checked = this.now();
    this.deps.store.emitEphemeral({
      kind: 'ephemeral',
      type: 'mesh.checked',
      mesh: this.deps.nom ?? 'principal',
      checkedAt: this.checked,
    });
    if (r.spawnErrorCode === 'ENOENT') return { monitor: 'absent', pending: 0, superviseur: null };
    // `status` peut sortir en code 1 quand rien ne tourne, avec un JSON lisible quand même
    return parseMonitorStatus(r.stdout);
  }

  private readPersisted(): Partial<MeshState> | null {
    const rows = this.deps.db
      .prepare('SELECT k, v FROM mesh_state WHERE mesh = ?')
      .all(this.deps.nom ?? 'principal') as {
      k: string;
      v: string;
    }[];
    if (rows.length === 0) return null;
    const out: Record<string, unknown> = {};
    for (const r of rows) {
      try {
        out[r.k] = JSON.parse(r.v);
      } catch {
        // valeur illisible : ignorée
      }
    }
    return out as Partial<MeshState>;
  }

  private cursorFromDb(): number {
    const row = this.deps.db
      .prepare('SELECT MAX(id) AS m FROM mesh_inbox WHERE mesh = ?')
      .get(this.deps.nom ?? 'principal') as {
      m: number | null;
    };
    return row.m ?? 0;
  }

  private startFollower(): void {
    if (this.follower) return;
    this.follower = new InboxFollower({
      file: this.paths.inboxLog,
      cursor: this.cursorFromDb(),
      pollMs: this.deps.pollMs,
      log: this.deps.log,
      onDm: (dm) =>
        this.deps.store.append({
          source: 'swarph',
          type: 'mesh.dm',
          data: { ...dm, mesh: this.deps.nom ?? 'principal', createdAt: dm.createdAt ?? undefined },
        }),
    });
    this.follower.start();
  }

  private stopFollower(): void {
    this.follower?.stop();
    this.follower = null;
  }

  private startRefresh(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setInterval(() => void this.refresh(), this.deps.refreshMs ?? 30_000);
    this.refreshTimer.unref();
  }

  private stopRefresh(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  /** Fusionne, et n'émet `mesh.state` que si quelque chose a changé. */
  private publish(patch: Partial<MeshState>): void {
    const next: MeshState = { ...this.state, ...patch };
    if (JSON.stringify(next) === JSON.stringify(this.state)) return;
    this.state = next;
    this.deps.store.append({
      source: 'swarph',
      type: 'mesh.state',
      data: { ...next, mesh: this.deps.nom ?? 'principal' },
    });
  }
}
