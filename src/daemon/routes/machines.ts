import type { FastifyInstance } from 'fastify';
import type { Fournisseurs, MachineLocale, MachineServeur } from '../../shared/model.js';
import type { AidConfig } from '../config.js';
import type { Db } from '../db.js';
import { AidHttpError } from '../errors.js';
import { MachineDiagnostics } from '../machines/diagnostic.js';
import { codexHome, fournisseurs } from '../machines/fournisseurs.js';
import { memoireLocale } from '../machines/memoire.js';
import { agentsDisponibles } from '../pty/disponibles.js';
import type { AgentManager } from '../pty/manager.js';
import type { ServerConnections } from '../remote/connection.js';
import { getServer, listServers } from '../remote/servers.js';

export interface MachineRouteDeps {
  config: AidConfig;
  agents: Pick<AgentManager, 'codexModels'>;
  db: Db;
  connections: ServerConnections;
  /** l'environnement du daemon, lu par présence seulement (D159) */
  env?: () => NodeJS.ProcessEnv;
}

// Chantier 29 : l'écran Machines. Lecture seule ; rien ne tourne en fond (D160).
export function registerMachineRoutes(app: FastifyInstance, deps: MachineRouteDeps): void {
  // D154 : le diagnostic du Mac, recalculé à chaque appel : `--version` (3 s au plus) et la mémoire
  app.get('/api/machines/local', async (): Promise<MachineLocale> => {
    const [{ agents }, octets] = await Promise.all([
      agentsDisponibles(deps.agents.codexModels()),
      memoireLocale(),
    ]);
    const mesureA = new Date().toISOString();
    return {
      agents,
      transport: deps.config.agents.transport,
      memoire: octets === null ? null : { octets, mesureA },
      mesureA,
    };
  });

  const diagnostics = new MachineDiagnostics(deps);

  // D155 : le dernier diagnostic enregistré de chaque serveur, et son dernier test s'il est encore en mémoire
  app.get('/api/machines/serveurs', async (): Promise<MachineServeur[]> =>
    listServers(deps.db).map((s) => diagnostics.lire(s.id)),
  );

  // D155 : le test de connexion, puis les versions et la mémoire ; attendu, la carte dit « Diagnostic… »
  app.post('/api/machines/serveurs/:id/diagnostic', async (req): Promise<MachineServeur> => {
    const { id } = req.params as { id: string };
    const server = getServer(deps.db, id);
    if (!server) throw new AidHttpError(404, `serveur ${id} inconnu`);
    return diagnostics.diagnostiquer(server);
  });

  // D159 : les accès aux modèles et les secrets en clair, par présence seulement
  app.get('/api/machines/fournisseurs', async (): Promise<Fournisseurs> => {
    const env = deps.env?.() ?? process.env;
    return fournisseurs({
      env,
      strip: deps.config.env.strip,
      ollama: deps.config.memory.embeddings.provider === 'ollama',
      codexHome: codexHome(env),
    });
  });
}
