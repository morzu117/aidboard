import type { Db } from '../db.js';
import { abonnementsActifs } from '../push/abonnements.js';
import { chargerOuCreerCles } from '../push/vapid.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  type AidConfig,
  ConfigError,
  ecrireModeHostActif,
  ecrireModeHostPush,
  ecrireModeHostCode,
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
    db: Db;
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
    return {
      ...e,
      ...deps.modeHost.etat(),
      push: deps.config.modeHost.push,
      code: deps.config.modeHost.code,
      abonnements: abonnementsActifs(deps.db, Date.now()).length,
    };
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

  app.put('/api/host/push', async (req, reply) => {
    if (req.principal?.kind !== 'admin') return reply.code(403).send({ error: 'admin seulement' });
    reply.header('Cache-Control', 'no-store');
    const actif = (req.body as { actif?: unknown } | null)?.actif;
    if (typeof actif !== 'boolean') return reply.code(400).send({ error: 'actif : true ou false' });
    try {
      if (actif) chargerOuCreerCles(deps.paths.home);
      ecrireModeHostPush(deps.paths, actif);
    } catch (err) {
      if (err instanceof ConfigError) return reply.code(409).send({ error: err.message });
      throw err;
    }
    deps.config.modeHost.push = actif;
    if (!actif) deps.db.prepare('DELETE FROM push_abonnements').run();
    return etat();
  });

  app.put('/api/host/code', async (req, reply) => {
    if (req.principal?.kind !== 'admin') return reply.code(403).send({ error: 'admin seulement' });
    reply.header('Cache-Control', 'no-store');
    const actif = (req.body as { actif?: unknown } | null)?.actif;
    if (typeof actif !== 'boolean') return reply.code(400).send({ error: 'actif : true ou false' });
    try {
      ecrireModeHostCode(deps.paths, actif);
    } catch (err) {
      if (err instanceof ConfigError) return reply.code(409).send({ error: err.message });
      throw err;
    }
    deps.config.modeHost.code = actif;
    return etat();
  });

  // D176 : l'appairage, côté Mac. Ces routes n'existent pas sur le port des appareils : un
  // appareil ne peut ni créer, ni voir, ni approuver une demande.
  const admin = (req: FastifyRequest, reply: FastifyReply) => {
    reply.header('Cache-Control', 'no-store');
    if (req.principal?.kind === 'admin') return true;
    void reply.code(403).send({ error: 'admin seulement' });
    return false;
  };
  app.post('/api/host/appairages', async (req, reply) => {
    if (!admin(req, reply)) return reply;
    const e = deps.modeHost.etat();
    const nom = deps.modeHost.nomLu();
    // un QR qui ne mènerait nulle part n'est pas émis
    if (!e.disponible || nom === null) {
      return reply.code(409).send({ error: e.raison ?? 'nom Tailscale du Mac non lu' });
    }
    const d = deps.modeHost.appairages.creer();
    // le code est dans le fragment : jamais dans un journal ni dans la requête envoyée
    return {
      demandeId: d.id,
      code: d.code,
      expireA: d.expireA,
      url: `https://${nom}/appairer#${d.code}`,
    };
  });
  app.get('/api/host/appairage', async (req, reply) => {
    if (!admin(req, reply)) return reply;
    // D179 : tant que la mesure de 31.2 manque, l'identité n'est qu'affichée, non vérifiable
    return { demande: deps.modeHost.appairages.vueMac(), identiteVerifiable: false };
  });
  app.post('/api/host/appairages/:id/approuver', async (req, reply) => {
    if (!admin(req, reply)) return reply;
    const { id } = req.params as { id: string };
    const sansIdentite = (req.body as { sansIdentite?: unknown } | null)?.sansIdentite === true;
    const r = deps.modeHost.appairages.approuver(id, { sansIdentite });
    if (r.ok) return { ok: true };
    return r.raison === 'identite-absente'
      ? reply.code(409).send({
          error: 'identite-absente',
          message: 'Aucune identité Tailscale : cocher « Appareil taggé, sans identité Tailscale »',
        })
      : reply.code(404).send({ error: 'demande inconnue, expirée ou annulée' });
  });
  // D177 : le registre vu du Mac, identité comprise ; jamais l'empreinte
  app.get('/api/host/appareils', async (req, reply) => {
    if (!admin(req, reply)) return reply;
    const abonnes = new Set(abonnementsActifs(deps.db, Date.now()).map((a) => a.appareilId));
    return deps.modeHost.registre.lister().map((a) => ({ ...a, push: abonnes.has(a.id) }));
  });
  app.delete('/api/host/appareils/:id', async (req, reply) => {
    if (!admin(req, reply)) return reply;
    const { id } = req.params as { id: string };
    if (!deps.modeHost.registre.revoquer(id)) {
      return reply.code(404).send({ error: 'appareil inconnu ou déjà coupé' });
    }
    return { ok: true };
  });
  // « Couper tous les accès » : tous les appareils, et la demande en cours. Le Mac reste.
  app.post('/api/host/couper', async (req, reply) => {
    if (!admin(req, reply)) return reply;
    deps.modeHost.appairages.toutAnnuler();
    return { coupes: deps.modeHost.registre.toutRevoquer().length };
  });
  app.post('/api/host/appairages/:id/refuser', async (req, reply) => {
    if (!admin(req, reply)) return reply;
    const { id } = req.params as { id: string };
    if (!deps.modeHost.appairages.refuser(id)) {
      return reply.code(404).send({ error: 'demande inconnue, expirée ou annulée' });
    }
    return { ok: true };
  });
}
