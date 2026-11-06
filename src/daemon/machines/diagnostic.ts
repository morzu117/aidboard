import type { MachineServeur, Server } from '../../shared/model.js';
import type { Db } from '../db.js';
import { KNOWN_AGENTS, type ServerConnections } from '../remote/connection.js';
import { getServer } from '../remote/servers.js';
import { MEMOIRE_CMD, parseMemoire } from './memoire.js';

const VERSION = 'aid-version:';
const MEMOIRE = 'aid-memoire';

/**
 * Chantier 29 (D155) : une seule commande distante, après le test de connexion. Les binaires viennent de
 * `KNOWN_AGENTS` (jeu fermé), jamais d'une saisie ; `--version` ne lance aucun tour d'agent.
 */
export function commandeDiagnostic(agents: string[]): string {
  const versions = KNOWN_AGENTS.filter(([, name]) => agents.includes(name)).map(
    ([bin, name]) =>
      `printf '%s %s\\n' '${VERSION}${name}' "$(${bin} --version 2>/dev/null | head -n 1)"`,
  );
  return [...versions, `echo ${MEMOIRE}`, MEMOIRE_CMD].join('; ');
}

/** « 2.1.0 (Claude Code) », « codex-cli 0.50.0 » : le numéro seul, sinon la ligne courte ; null si vide. */
function numero(ligne: string): string | null {
  const n = /\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/.exec(ligne)?.[0];
  return n ?? (ligne ? ligne.slice(0, 40) : null);
}

export function lireDiagnostic(out: string): {
  versions: Record<string, string | null>;
  octets: number | null;
} {
  const versions: Record<string, string | null> = {};
  const lignes = out.split('\n');
  for (const l of lignes) {
    if (!l.startsWith(VERSION)) continue;
    const [name, ...reste] = l.slice(VERSION.length).split(' ');
    if (name) versions[name] = numero(reste.join(' ').trim());
  }
  const i = lignes.findIndex((l) => l.trim() === MEMOIRE);
  return { versions, octets: i < 0 ? null : parseMemoire(lignes.slice(i + 1).join('\n')) };
}

interface DiagnosticRow {
  versions: string;
  memory_bytes: number | null;
  measured_at: string;
}

export class MachineDiagnostics {
  constructor(private readonly deps: { db: Db; connections: ServerConnections }) {}

  /**
   * Diagnostiquer : le test de connexion existant (un test déjà en cours, lancé depuis la configuration, est attendu,
   * pas doublé), puis, si le shell distant a répondu, les versions et la mémoire.
   */
  async diagnostiquer(server: Server): Promise<MachineServeur> {
    const { connections, db } = this.deps;
    connections.startTest(server);
    const test = await connections.testFini(server.id);
    const shell = test?.steps.find((s) => s.id === 'shell')?.state === 'ok';
    // les agents relus après le test, qui vient de les enregistrer
    const agents = getServer(db, server.id)?.detectedAgents ?? [];
    if (shell) {
      try {
        const r = await connections.read(server, commandeDiagnostic(agents));
        const { versions, octets } = lireDiagnostic(r.stdout);
        db.prepare(
          `INSERT INTO server_diagnostics (server_id, versions, memory_bytes, measured_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(server_id) DO UPDATE SET versions = excluded.versions, memory_bytes = excluded.memory_bytes,
           measured_at = excluded.measured_at`,
        ).run(server.id, JSON.stringify(versions), octets, new Date().toISOString());
      } catch {
        // coupure (502, l'état du serveur le dit) ou serveur supprimé pendant le diagnostic : rien à enregistrer
      }
    }
    return this.lire(server.id);
  }

  lire(serverId: string): MachineServeur {
    const row = this.deps.db
      .prepare(
        'SELECT versions, memory_bytes, measured_at FROM server_diagnostics WHERE server_id = ?',
      )
      .get(serverId) as DiagnosticRow | undefined;
    return {
      serverId,
      test: this.deps.connections.lastTest(serverId),
      versions: row ? (JSON.parse(row.versions) as Record<string, string | null>) : null,
      memoire:
        row && row.memory_bytes !== null
          ? { octets: row.memory_bytes, mesureA: row.measured_at }
          : null,
      mesureA: row?.measured_at ?? null,
    };
  }
}
