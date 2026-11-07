import type { FastifyInstance } from 'fastify';
import { type AidConfig, PORT_PONT_TAURI, portAppareils, portArtefacts } from '../config.js';
import { commandeServe, lireServe, lireTailnet, type TailscaleExec } from '../mesh/tailscale.js';
import type { EtatModeHost } from '../../shared/host.js';

// Chantier 31 (D172, D173) : l'état du mode host, vu du Mac. Tailscale est lu à la demande,
// jamais en tâche de fond, jamais piloté (D37).

export async function etatModeHost(
  config: AidConfig,
  portDaemon: number,
  exec?: TailscaleExec,
): Promise<EtatModeHost> {
  const port = portAppareils(config);
  const bin = config.mesh.tailscale.bin;
  const [tailnet, serve] = await Promise.all([
    lireTailnet(bin, exec),
    lireServe(
      bin,
      { appareils: port, interdits: [portDaemon, PORT_PONT_TAURI, portArtefacts(config)] },
      exec,
    ),
  ]);
  return { actif: config.modeHost.actif, port, tailnet, serve, commande: commandeServe(port) };
}

export function registerHostRoutes(
  app: FastifyInstance,
  deps: { config: AidConfig; getPort: () => number; tailscaleExec?: TailscaleExec },
): void {
  // le port du Mac seulement : le port des appareils (31.5) n'enregistre jamais cette route
  app.get('/api/host', async (req, reply) => {
    if (req.principal?.kind !== 'admin') return reply.code(403).send({ error: 'admin seulement' });
    reply.header('Cache-Control', 'no-store');
    return etatModeHost(deps.config, deps.getPort(), deps.tailscaleExec);
  });
}
