import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { meshPaths } from '../mesh/paths.js';
import { loadConfig, type AidConfig, ConfigError } from '../config.js';
import { ajouterMesh, oublierMesh } from '../mesh/config-rejoindre.js';
import {
  LanceurRejoindre,
  validerGatewayRejoindre,
  type DemandeRejoindre,
} from '../mesh/rejoindre.js';
import type { AidPaths } from '../paths.js';
import { lireVersionCommande } from '../../shared/version-commande.js';
import { swarphAtLeast, SWARPH_REJOINDRE_MIN } from '../../shared/swarph-version.js';

/** D335 : enregistré uniquement par le serveur principal, jamais par le port des appareils. */
export function registerRejoindreRoutes(
  app: FastifyInstance,
  deps: { config: AidConfig; paths: AidPaths },
): void {
  const enregistrer = (demande: DemandeRejoindre) => {
    try {
      ajouterMesh(deps.paths, demande.mesh, {
        cell: demande.cell,
        gateway: demande.gateway,
        ...(deps.config.mesh.home ? { home: deps.config.mesh.home } : {}),
      });
      return { redemarrage: true };
    } catch (erreur) {
      return {
        redemarrage: false,
        libelle:
          erreur instanceof ConfigError && erreur.message === 'Mesh déjà configuré'
            ? 'Mesh déjà configuré : rien n’est écrit'
            : 'Configuration non écrite : vérifier config.yaml ; la cell est inscrite',
      };
    }
  };
  const lanceur = new LanceurRejoindre(deps.config, enregistrer, deps.paths);
  // Inclut la lecture de version asynchrone dans l'exclusion des demandes concurrentes.
  let contexte: (DemandeRejoindre & { cheminJeton: string }) | undefined;
  const etat = () => ({ ...lanceur.etat(), ...contexte });
  let lancement = false;
  let preparation: Promise<void> | undefined;
  const admin = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (req.principal?.kind !== 'admin') {
      reply.code(403).send({ error: 'admin seulement' });
      return false;
    }
    reply.header('Cache-Control', 'no-store');
    return true;
  };
  app.addHook('onClose', async () => {
    await preparation;
    await lanceur.annuler();
  });
  app.get('/api/meshes/rejoindre', async (req, reply) => {
    if (!admin(req, reply)) return reply;
    return etat();
  });
  app.post('/api/meshes/rejoindre', async (req, reply) => {
    if (!admin(req, reply)) return reply;
    if (lancement || ['demande', 'en-attente'].includes(lanceur.etat().etat))
      return reply.code(409).send({ error: 'Une demande est déjà en cours' });
    const corps = req.body as Partial<DemandeRejoindre> | null;
    if (
      !corps ||
      typeof corps.gateway !== 'string' ||
      typeof corps.cell !== 'string' ||
      typeof corps.mesh !== 'string' ||
      Object.keys(corps).some((cle) => !['gateway', 'cell', 'mesh'].includes(cle))
    )
      return reply.code(400).send({ error: 'gateway, cell et mesh : trois chaînes requises' });
    lancement = true;
    let terminer!: () => void;
    preparation = new Promise<void>((resolve) => {
      terminer = resolve;
    });
    try {
      const version = await lireVersionCommande(deps.config.mesh.bin, ['--version']);
      if (!version || !/\d+\.\d+\.\d+/.test(version))
        return reply.code(400).send({ error: 'Version de swarph illisible' });
      if (!swarphAtLeast(version, SWARPH_REJOINDRE_MIN))
        return reply.code(400).send({
          error: 'swarph trop ancien pour rejoindre un mesh (0.80.0 ou plus)',
        });
      // Le fichier peut avoir changé depuis le démarrage ; ne pas lancer pour un mesh déjà ajouté.
      if (Object.hasOwn(loadConfig(deps.paths).meshes, corps.mesh))
        return reply.code(400).send({ error: 'Mesh déjà configuré' });
      lanceur.lancer(corps as DemandeRejoindre);
      contexte = {
        ...(corps as DemandeRejoindre),
        gateway: validerGatewayRejoindre(corps.gateway),
        cheminJeton: meshPaths({ ...deps.config.mesh, cell: corps.cell }).tokenFile,
      };
      return etat();
    } catch (erreur) {
      return reply.code(400).send({
        error:
          erreur instanceof ConfigError
            ? 'config.yaml invalide ou illisible'
            : (erreur as Error).message,
      });
    } finally {
      lancement = false;
      terminer();
    }
  });
  app.delete('/api/meshes/rejoindre', async (req, reply) => {
    if (!admin(req, reply)) return reply;
    await preparation;
    await lanceur.annuler();
    return etat();
  });
  app.delete('/api/meshes/config/:mesh', async (req, reply) => {
    if (!admin(req, reply)) return reply;
    const { mesh } = req.params as { mesh: string };
    if (mesh === 'principal')
      return reply.code(400).send({ error: 'principal ne s’oublie pas ici' });
    try {
      oublierMesh(deps.paths, mesh);
    } catch (erreur) {
      if (erreur instanceof ConfigError && erreur.message === 'Mesh inconnu')
        return reply.code(404).send({ error: 'Mesh absent de la config' });
      if (erreur instanceof ConfigError) return reply.code(409).send({ error: erreur.message });
      throw erreur;
    }
    return {
      redemarrage: true,
      message: 'Le jeton existe toujours. Pour le révoquer, demande à l’opérateur du gateway.',
    };
  });
}
