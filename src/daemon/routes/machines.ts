import type { FastifyInstance } from 'fastify';
import type { MachineLocale } from '../../shared/model.js';
import type { AidConfig } from '../config.js';
import { memoireLocale } from '../machines/memoire.js';
import { agentsDisponibles } from '../pty/disponibles.js';
import type { AgentManager } from '../pty/manager.js';

export interface MachineRouteDeps {
  config: AidConfig;
  agents: Pick<AgentManager, 'codexModels'>;
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
}
