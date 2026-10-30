import type { Server, ServerStatus, ServerTest, ServerTestStepId } from '../../shared/model.js';
import type { Db } from '../db.js';
import type { EventStore } from '../events/store.js';
import { resolveOnPath } from '../pty/spawn.js';
import { listServers } from './servers.js';
import { type ExecResult, remoteExec, shQuote, type TransportOptions } from './transport.js';

const PING_TIMEOUT_MS = 15_000;
/** Âge au-delà duquel une lecture de l'état relance un contrôle (§11.1 : « rafraîchie périodiquement »). */
export const STATUS_MAX_AGE_MS = 60_000;
const RAW_MAX = 64 * 1024;
const MARK = 'aid-ok';

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
): { state: 'unreachable' | 'error'; reason: string } {
  if (r.timedOut) return { state: 'unreachable', reason: `délai dépassé (${timeoutMs / 1000} s)` };
  if (r.code === null)
    return { state: 'error', reason: lastLine(r.stderr) || 'commande de connexion introuvable' };
  // 255 : code de `ssh` quand la connexion ou l'authentification échoue (jamais celui de la commande distante).
  if (r.code === 255)
    return { state: 'unreachable', reason: lastLine(r.stderr) || 'connexion impossible' };
  return { state: 'error', reason: lastLine(r.stderr) || `code de sortie ${r.code}` };
}

export interface ServerConnectionsDeps {
  db: Db;
  store: EventStore;
  transport: TransportOptions;
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
    if (this.status(server.id).state === 'unknown')
      this.setStatus(server.id, { state: 'connecting' });
    const p = remoteExec(server, `echo ${MARK}`, {
      ...this.deps.transport,
      timeoutMs: PING_TIMEOUT_MS,
    }).then((r) => {
      this.pings.delete(server.id);
      return this.record(server.id, r, PING_TIMEOUT_MS);
    });
    this.pings.set(server.id, p);
    return p;
  }

  lastTest(serverId: string): ServerTest | null {
    return this.tests.get(serverId) ?? null;
  }

  testRunning(serverId: string): boolean {
    const t = this.tests.get(serverId);
    return !!t && t.finishedAt === null;
  }

  /** Lance le test (§11.2) en tâche de fond et rend son état initial ; un test déjà en cours est rendu tel quel. */
  startTest(server: Server): ServerTest {
    const current = this.tests.get(server.id);
    if (current && current.finishedAt === null) return current;
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
    void this.runTest(server, test);
    return structuredClone(test);
  }

  /** Les résultats qui arrivent après l'arrêt du daemon sont ignorés : la base est déjà fermée. */
  dispose(): void {
    this.disposed = true;
  }

  forget(serverId: string): void {
    this.statuses.delete(serverId);
    this.tests.delete(serverId);
  }

  private exec(server: Server, cmd: string): Promise<ExecResult> {
    return remoteExec(server, cmd, { ...this.deps.transport, timeoutMs: PING_TIMEOUT_MS });
  }

  private async runTest(server: Server, test: ServerTest): Promise<void> {
    const step = async (
      id: ServerTestStepId,
      run: () => Promise<{ detail: string; state?: 'ok' | 'skipped' }>,
    ): Promise<void> => {
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
        const r = await remote('shell', `echo ${MARK}`);
        this.record(server.id, r, PING_TIMEOUT_MS);
        if (r.code !== 0 || !r.stdout.includes(MARK))
          throw new StepFailed(
            r.code === 0 ? 'le shell distant n’a pas répondu' : classify(r, PING_TIMEOUT_MS).reason,
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
    }
    test.finishedAt = new Date().toISOString();
    if (this.disposed) return;
    try {
      // Agents détectés : gardés même si une étape suivante échoue ; `null` si l'étape n'a pas tourné.
      if (detected !== null || test.steps.find((s) => s.id === 'agents')?.state === 'failed')
        this.deps.db
          .prepare('UPDATE servers SET detected_agents = ?, last_test_at = ? WHERE id = ?')
          .run(JSON.stringify(detected ?? []), test.finishedAt, server.id);
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

  private record(serverId: string, r: ExecResult, timeoutMs: number): ServerStatus {
    if (r.code === 0 && r.stdout.includes(MARK))
      return this.setStatus(serverId, {
        state: 'connected',
        latencyMs: r.durationMs,
        reason: null,
      });
    const c = classify(r, timeoutMs);
    return this.setStatus(serverId, { state: c.state, latencyMs: null, reason: c.reason });
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
    if (this.disposed) return;
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
