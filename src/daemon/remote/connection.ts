import type { Server, ServerStatus, ServerTest, ServerTestStepId } from '../../shared/model.js';
import type { Db } from '../db.js';
import { AidHttpError } from '../errors.js';
import type { EventStore } from '../events/store.js';
import { resolveOnPath } from '../pty/spawn.js';
import { listServers } from './servers.js';
import { type ExecResult, remoteExec, shQuote, type TransportOptions } from './transport.js';

const PING_TIMEOUT_MS = 15_000;
/** Âge au-delà duquel une lecture de l'état relance un contrôle (§11.1 : « rafraîchie périodiquement »). */
export const STATUS_MAX_AGE_MS = 60_000;
const RAW_MAX = 64 * 1024;
const MARK = 'aid-ok';
/**
 * Décision opérateur du 2026-10-30 : shell de connexion non POSIX (fish, csh…) non supporté pour le moment.
 * Toute commande distante passe par lui, doublement quotée : il doit garder `\\` et un saut de ligne entre
 * quotes simples — fish réduit l'un, csh refuse l'autre (« Unmatched ' »). La sonde voyage avec chaque
 * ping : sans connexion de plus, un serveur dont le shell change après le test ne paraît jamais sain.
 */
const POSIX_PROBE = "printf '%s|' 'a\\\\b' 'c\nd'";
const POSIX_PROBE_OUT = 'a\\\\b|c\nd|';
const PING = `echo ${MARK}; ${POSIX_PROBE}`;
export const UNSUPPORTED_LOGIN_SHELL =
  'shell de connexion du serveur non POSIX (fish, csh…) : non supporté pour le moment, les commandes A-I-D y seraient altérées';

/** Une coupure n'est jamais un verdict sur le shell ; sinon fish (sonde altérée) ou csh (quote refusée). */
function loginShellUnsupported(r: ExecResult, mode: Server['mode']): boolean {
  if (connectionLost(r, mode)) return false;
  if (r.stdout.includes(MARK)) return !r.stdout.includes(POSIX_PROBE_OUT);
  return /Unmatched '/.test(r.stderr);
}

/** Agents connus (§11.2) : binaire cherché sur le serveur → nom affiché. */
const KNOWN_AGENTS: ReadonlyArray<[bin: string, name: string]> = [
  ['claude', 'claude'],
  ['codex', 'codex'],
  ['cursor-agent', 'cursor'],
];

const STEP_LABELS: Record<ServerTestStepId, string> = {
  command: 'Commande trouvée',
  shell: 'Shell distant ouvert',
  workdir: 'Répertoire de travail accessible',
  agents: 'Agents détectés',
  session: 'Session persistante disponible',
};

class StepFailed extends Error {}

function lastLine(s: string): string {
  return (
    s
      .trim()
      .split('\n')
      .filter((l) => l.trim())
      .at(-1) ?? ''
  );
}

/** Échec d'un aller-retour : `unreachable` si la connexion elle-même a échoué, `error` sinon. */
function classify(
  r: ExecResult,
  timeoutMs: number,
  mode: Server['mode'],
): { state: 'unreachable' | 'error'; reason: string } {
  if (r.timedOut) return { state: 'unreachable', reason: `délai dépassé (${timeoutMs / 1000} s)` };
  if (r.code === null)
    return { state: 'error', reason: lastLine(r.stderr) || 'commande de connexion introuvable' };
  // 255 : code de `ssh` quand la connexion ou l'authentification échoue (jamais celui de la commande distante) ;
  // en mode commande locale, il peut venir de la commande elle-même (review S.3).
  if (r.code === 255 && mode !== 'command')
    return { state: 'unreachable', reason: lastLine(r.stderr) || 'connexion impossible' };
  return { state: 'error', reason: lastLine(r.stderr) || `code de sortie ${r.code}` };
}

/** La connexion elle-même a lâché (délai, signal, 255 de ssh) : le code ne dit rien de la commande. */
function connectionLost(r: ExecResult, mode: Server['mode']): boolean {
  return r.timedOut || r.code === null || (r.code === 255 && mode !== 'command');
}

export interface ServerConnectionsDeps {
  db: Db;
  store: EventStore;
  transport: TransportOptions;
  /** Délai d'un aller-retour (15 s) ; réduit en test. */
  timeoutMs?: number;
}

/**
 * Chantier 17 (S.3) : état de connexion des serveurs (en mémoire, jamais en base) et test de connexion.
 * Tout passe par le daemon local (§11.0) ; chaque changement part en message éphémère sur `/ws/events`.
 */
export class ServerConnections {
  private statuses = new Map<string, ServerStatus>();
  private pings = new Map<string, Promise<ServerStatus>>();
  private tests = new Map<string, ServerTest>();
  private disposed = false;
  private readonly abort = new AbortController();

  constructor(private readonly deps: ServerConnectionsDeps) {}

  status(serverId: string): ServerStatus {
    return (
      this.statuses.get(serverId) ?? {
        serverId,
        state: 'unknown',
        latencyMs: null,
        checkedAt: null,
        reason: null,
      }
    );
  }

  /** Tous les serveurs ; relance en tâche de fond le contrôle de ceux dont l'état date de plus de `maxAgeMs`. */
  statusesRefreshing(maxAgeMs = STATUS_MAX_AGE_MS): ServerStatus[] {
    const now = Date.now();
    return listServers(this.deps.db).map((s) => {
      const st = this.status(s.id);
      const age = st.checkedAt === null ? Infinity : now - Date.parse(st.checkedAt);
      if (age > maxAgeMs && !this.pings.has(s.id) && !this.testRunning(s.id)) void this.ping(s);
      return this.status(s.id);
    });
  }

  /** Un aller-retour minimal : mesure la latence et fixe l'état. Un seul contrôle à la fois par serveur. */
  ping(server: Server): Promise<ServerStatus> {
    const inFlight = this.pings.get(server.id);
    if (inFlight) return inFlight;
    // pendant un test, l'étape `shell` fait foi : un ping parti avant n'écraserait qu'avec une mesure plus vieille
    if (this.testRunning(server.id)) return Promise.resolve(this.status(server.id));
    // un serveur sain ne clignote pas à chaque contrôle périodique ; un « Reconnecter » se voit
    if (this.status(server.id).state !== 'connected')
      this.setStatus(server.id, { state: 'connecting' });
    const p = this.exec(server, PING)
      .then((r) => this.record(server, r))
      .catch((e: unknown) =>
        this.setStatus(server.id, {
          state: 'error',
          latencyMs: null,
          reason: e instanceof Error ? e.message : String(e),
        }),
      )
      .finally(() => this.pings.delete(server.id));
    this.pings.set(server.id, p);
    return p;
  }

  lastTest(serverId: string): ServerTest | null {
    const t = this.tests.get(serverId);
    return t ? structuredClone(t) : null;
  }

  testRunning(serverId: string): boolean {
    const t = this.tests.get(serverId);
    return !!t && t.finishedAt === null;
  }

  /** Lance le test (§11.2) en tâche de fond et rend son état initial ; un test déjà en cours est rendu tel quel. */
  startTest(server: Server): ServerTest {
    const current = this.tests.get(server.id);
    if (current && current.finishedAt === null) return structuredClone(current);
    const test: ServerTest = {
      serverId: server.id,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      ok: null,
      error: null,
      steps: (Object.keys(STEP_LABELS) as ServerTestStepId[]).map((id) => ({
        id,
        label: STEP_LABELS[id],
        state: 'pending',
        durationMs: null,
        detail: null,
      })),
      raw: '',
    };
    this.tests.set(server.id, test);
    this.setStatus(server.id, { state: 'connecting' });
    void this.runTest(server, test).catch((e: unknown) => {
      // filet : `runTest` ne lève pas, mais un rejet non traité arrêterait le daemon
      test.ok = false;
      test.error ??= e instanceof Error ? e.message : String(e);
      test.finishedAt ??= new Date().toISOString();
    });
    return structuredClone(test);
  }

  /** Arrêt du daemon : les commandes en vol sont tuées, plus rien n'est lancé ni publié. */
  dispose(): void {
    this.disposed = true;
    this.abort.abort();
  }

  /**
   * F.1 : une commande de lecture du panneau Fichiers / Git. Une connexion perdue marque le serveur
   * injoignable (la pastille et le bandeau le disent) et répond 502 ; le code de la commande reste à l'appelant.
   */
  async read(server: Server, cmd: string): Promise<ExecResult> {
    this.assertSupported(server);
    const r = await this.exec(server, cmd);
    if (!connectionLost(r, server.mode)) return r;
    const c = classify(r, this.timeoutMs, server.mode);
    this.setStatus(server.id, { state: c.state, latencyMs: null, reason: c.reason });
    throw new AidHttpError(502, `${server.name} ne répond pas : ${c.reason}`);
  }

  /** F.2 : comme `read`, avec un délai propre — fetch / push passent par le réseau du serveur. */
  async run(server: Server, cmd: string, timeoutMs: number): Promise<ExecResult> {
    this.assertSupported(server);
    const r = await remoteExec(server, cmd, {
      ...this.deps.transport,
      timeoutMs,
      signal: this.abort.signal,
    });
    if (!connectionLost(r, server.mode)) return r;
    const c = classify(r, timeoutMs, server.mode);
    this.setStatus(server.id, { state: c.state, latencyMs: null, reason: c.reason });
    throw new AidHttpError(502, `${server.name} ne répond pas : ${c.reason}`);
  }

  /**
   * Review complète : shell de connexion non POSIX constaté (test ou ping) — aucune commande du panneau n'y part,
   * elle y serait altérée. Levé par le prochain ping sain (« Reconnecter »).
   */
  private assertSupported(server: Server): void {
    if (this.status(server.id).reason === UNSUPPORTED_LOGIN_SHELL)
      throw new AidHttpError(
        409,
        `${server.name} : ${UNSUPPORTED_LOGIN_SHELL} (Reconnecter une fois le shell changé)`,
      );
  }

  forget(serverId: string): void {
    this.statuses.delete(serverId);
    this.tests.delete(serverId);
  }

  private get timeoutMs(): number {
    return this.deps.timeoutMs ?? PING_TIMEOUT_MS;
  }

  private exec(server: Server, cmd: string): Promise<ExecResult> {
    return remoteExec(server, cmd, {
      ...this.deps.transport,
      timeoutMs: this.timeoutMs,
      signal: this.abort.signal,
    });
  }

  /** Serveur supprimé (ou recréé) pendant le test, ou daemon arrêté : le test est abandonné. */
  private orphan(test: ServerTest): boolean {
    return this.disposed || this.tests.get(test.serverId) !== test;
  }

  private async runTest(server: Server, test: ServerTest): Promise<void> {
    const step = async (
      id: ServerTestStepId,
      run: () => Promise<{ detail: string; state?: 'ok' | 'skipped' }>,
    ): Promise<void> => {
      if (this.orphan(test)) throw new StepFailed('test abandonné');
      const s = test.steps.find((x) => x.id === id)!;
      s.state = 'running';
      this.publishTest(test);
      const started = Date.now();
      try {
        const out = await run();
        s.state = out.state ?? 'ok';
        s.detail = out.detail;
      } catch (e) {
        s.state = 'failed';
        s.detail = (e as Error).message;
        throw e;
      } finally {
        s.durationMs = Date.now() - started;
        this.publishTest(test);
      }
    };
    const remote = async (label: string, cmd: string): Promise<ExecResult> => {
      const r = await this.exec(server, cmd);
      this.appendRaw(
        test,
        `$ ${label}\n${r.stdout}${r.stderr}${r.code === 0 ? '' : `[code ${r.code ?? '—'}]\n`}`,
      );
      if (r.timedOut) this.appendRaw(test, '[délai dépassé]\n');
      // une coupure en cours de test : on dit la coupure, pas « répertoire inaccessible » ou « tmux absent »
      if (label !== 'shell' && connectionLost(r, server.mode)) {
        this.record(server, r);
        throw new StepFailed(classify(r, this.timeoutMs, server.mode).reason);
      }
      return r;
    };

    let detected: string[] | null = null;
    try {
      await step('command', async () => {
        const found = this.localCommand(server);
        if (!found.path) throw new StepFailed(found.error);
        return { detail: found.path };
      });
      await step('shell', async () => {
        const r = await remote('shell', PING);
        this.record(server, r);
        if (loginShellUnsupported(r, server.mode)) throw new StepFailed(UNSUPPORTED_LOGIN_SHELL);
        if (r.code !== 0 || !r.stdout.includes(MARK))
          throw new StepFailed(
            r.code === 0
              ? 'le shell distant n’a pas répondu'
              : classify(r, this.timeoutMs, server.mode).reason,
          );
        return { detail: `${r.durationMs} ms` };
      });
      await step('workdir', async () => {
        // `workdir` est en jeu de caractères fermé (S.1) : `~` reste hors guillemets pour être développé.
        const r = await remote('workdir', `cd ${server.workdir} && pwd`);
        if (r.code !== 0)
          throw new StepFailed(
            `${server.workdir} inaccessible : ${lastLine(r.stderr) || `code ${r.code}`}`,
          );
        return { detail: lastLine(r.stdout) };
      });
      await step('agents', async () => {
        const script = KNOWN_AGENTS.map(
          ([bin]) => `if command -v ${bin} >/dev/null 2>&1; then echo ${bin}; fi`,
        ).join('; ');
        const r = await remote('agents', `${script}; true`);
        if (r.code !== 0) throw new StepFailed(lastLine(r.stderr) || `code ${r.code}`);
        const bins = new Set(r.stdout.split('\n').map((l) => l.trim()));
        detected = KNOWN_AGENTS.filter(([bin]) => bins.has(bin)).map(([, name]) => name);
        if (detected.length === 0)
          throw new StepFailed('aucun agent (claude, codex, cursor) dans le PATH du shell distant');
        return { detail: detected.join(' · ') };
      });
      await step('session', async () => {
        if (!server.keepSession) return { detail: 'désactivée', state: 'skipped' };
        const r = await remote('session', 'command -v tmux');
        if (r.code !== 0)
          throw new StepFailed(
            'tmux absent du serveur : la session ne survivrait pas à une coupure',
          );
        return { detail: 'tmux' };
      });
      test.ok = true;
    } catch (e) {
      test.ok = false;
      test.error = (e as Error).message;
      for (const s of test.steps) if (s.state === 'pending') s.state = 'skipped';
      // l'étape `command` échoue avant tout aller-retour : l'état ne reste pas « connexion… » (review S.3)
      if (!this.orphan(test) && this.status(server.id).state === 'connecting')
        this.setStatus(server.id, { state: 'error', latencyMs: null, reason: test.error });
    }
    test.finishedAt = new Date().toISOString();
    if (this.orphan(test)) return;
    try {
      // Agents détectés : gardés même si une étape suivante échoue ; inchangés si la liste n'a pas pu être lue
      // (étape non jouée, coupure) — `[]` seulement quand le serveur a répondu sans aucun agent.
      if (detected !== null)
        this.deps.db
          .prepare('UPDATE servers SET detected_agents = ?, last_test_at = ? WHERE id = ?')
          .run(JSON.stringify(detected), test.finishedAt, server.id);
      else
        this.deps.db
          .prepare('UPDATE servers SET last_test_at = ? WHERE id = ?')
          .run(test.finishedAt, server.id);
    } catch {
      // serveur supprimé pendant le test, ou base fermée : rien à enregistrer
    }
    this.publishTest(test);
  }

  /** Étape 1 : le binaire local qui ouvre la connexion existe-t-il ? (`ssh`, ou le préfixe de la commande locale). */
  private localCommand(server: Server): { path: string | null; error: string } {
    const env = this.deps.transport.env ?? process.env;
    const pathVar = env.PATH ?? '';
    if (server.mode !== 'command') {
      const bin = this.deps.transport.ssh ?? 'ssh';
      return {
        path: resolveOnPath(bin, pathVar),
        error: `${bin} introuvable dans le PATH du daemon`,
      };
    }
    const first = server.target.split(/\s+/)[0] ?? '';
    const path = resolveOnPath(first, pathVar);
    // une fonction ou un alias du profil n'est pas sur le PATH : l'étape suivante dira s'il répond
    if (!path && server.loadProfile) return { path: `${first} (profil shell)`, error: '' };
    return { path, error: `${shQuote(first)} introuvable dans le PATH du daemon` };
  }

  private record(server: Server, r: ExecResult): ServerStatus {
    if (loginShellUnsupported(r, server.mode))
      return this.setStatus(server.id, {
        state: 'error',
        latencyMs: null,
        reason: UNSUPPORTED_LOGIN_SHELL,
      });
    if (r.code === 0 && r.stdout.includes(MARK))
      return this.setStatus(server.id, {
        state: 'connected',
        latencyMs: r.durationMs,
        reason: null,
      });
    const c = classify(r, this.timeoutMs, server.mode);
    return this.setStatus(server.id, { state: c.state, latencyMs: null, reason: c.reason });
  }

  private setStatus(serverId: string, patch: Partial<ServerStatus>): ServerStatus {
    const next: ServerStatus = {
      ...this.status(serverId),
      ...patch,
      serverId,
      checkedAt:
        patch.state === 'connecting' ? this.status(serverId).checkedAt : new Date().toISOString(),
    };
    if (this.disposed || !getServerSafe(this.deps.db, serverId)) return next;
    this.statuses.set(serverId, next);
    this.deps.store.emitEphemeral({ kind: 'ephemeral', type: 'server.status', status: next });
    return next;
  }

  private appendRaw(test: ServerTest, chunk: string): void {
    test.raw = (test.raw + chunk).slice(-RAW_MAX);
  }

  private publishTest(test: ServerTest): void {
    if (this.orphan(test)) return;
    this.deps.store.emitEphemeral({
      kind: 'ephemeral',
      type: 'server.test',
      test: structuredClone(test),
    });
  }
}

function getServerSafe(db: Db, id: string): boolean {
  try {
    return !!db.prepare('SELECT 1 FROM servers WHERE id = ?').get(id);
  } catch {
    return false;
  }
}
