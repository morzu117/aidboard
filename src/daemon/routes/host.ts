import type { FastifyInstance } from 'fastify';
import {
  type AidConfig,
  ConfigError,
  ecrireModeHostActif,
  PORT_PONT_TAURI,
  portAppareils,
  portArtefacts,
} from '../config.js';
import type { ModeHost } from '../host/controleur.js';
import type { AidPaths } from '../paths.js';
import { commandeServe, lireServe, lireTailnet, type TailscaleExec } from '../mesh/tailscale.js';
import type { EtatModeHost, EtatModeHostDaemon } from '../../shared/host.js';

// Chantier 31 (D172, D173) : l'état du mode host, vu du Mac. Tailscale est lu à la demande,
// jamais en tâche de fond, jamais piloté (D37).

export async function etatModeHost(
  config: AidConfig,
  portDaemon: number,
  exec?: TailscaleExec,
  /** le port réellement ouvert, s'il diffère de la config (0 en test) */
  portOuvert?: number | null,
): Promise<EtatModeHost> {
  const port = portOuvert ?? portAppareils(config);
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
  deps: {
    config: AidConfig;
    paths: AidPaths;
    getPort: () => number;
    modeHost: ModeHost;
    tailscaleExec?: TailscaleExec;
  },
): void {
  const etat = async (): Promise<EtatModeHostDaemon> => {
    const e = await etatModeHost(
      deps.config,
      deps.getPort(),
      deps.tailscaleExec,
      deps.modeHost.portOuvert(),
    );
    // un nom apparu ou changé (MagicDNS activé après coup) est pris par le port des appareils
    if (e.tailnet.etat === 'running') deps.modeHost.noterNom(e.tailnet.nom);
    return { ...e, ...deps.modeHost.etat() };
  };
  // le port du Mac seulement : le port des appareils n'enregistre jamais ces routes
  app.get('/api/host', async (req, reply) => {
    if (req.principal?.kind !== 'admin') return reply.code(403).send({ error: 'admin seulement' });
    reply.header('Cache-Control', 'no-store');
    return etat();
  });
  // D172 : démarre ou arrête le port des appareils sans redémarrer le daemon, puis l'écrit.
  // Éteindre coupe tous les accès et annule la demande d'appairage (D177).
  app.put('/api/host', async (req, reply) => {
    if (req.principal?.kind !== 'admin') return reply.code(403).send({ error: 'admin seulement' });
    reply.header('Cache-Control', 'no-store');
    const actif = (req.body as { actif?: unknown } | null)?.actif;
    if (typeof actif !== 'boolean') return reply.code(400).send({ error: 'actif : true ou false' });
    try {
      ecrireModeHostActif(deps.paths, actif);
    } catch (err) {
      if (err instanceof ConfigError) return reply.code(409).send({ error: err.message });
      throw err;
    }
    deps.config.modeHost.actif = actif;
    if (actif) await deps.modeHost.demarrer();
    else await deps.modeHost.arreter({ couper: true });
    return etat();
  });
}
