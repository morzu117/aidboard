import { ACTIONS_MESH } from '../../shared/confirmations.js';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db.js';
import { creerReglage } from '../confirmations/reglage.js';
import type { Porte } from '../confirmations/porte.js';
import type { FilePda } from '../pda/file.js';

// Enregistrées uniquement sur le port du Mac.
export function registerConfirmationRoutes(
  app: FastifyInstance,
  db: Db,
  porte: Porte,
  file: () => FilePda | null,
): void {
  const reglage = creerReglage(db);
  app.get('/api/confirmations/reglage', async (req, reply) => {
    if (req.principal?.kind !== 'admin') return reply.code(403).send({ error: 'admin seulement' });
    const armement = reglage.lireArmement();
    const { n } = db
      .prepare("SELECT count(*) AS n FROM pda_appareils WHERE etat = 'actif'")
      .get() as { n: number };
    const bandeau =
      armement.desarmeA !== null && armement.desarmeA > (armement.armeA ?? 0)
        ? 'desarme'
        : armement.arme && n === 1
          ? 'amorcage'
          : null;
    return { actions: reglage.lire(), ...armement, bandeau };
  });
  app.post('/api/confirmations/armer', async (req, reply) => {
    if (req.principal?.kind !== 'admin') return reply.code(403).send({ error: 'admin seulement' });
    reglage.armer();
    return { ok: true };
  });
  app.post('/api/confirmations/desarmer', async (req, reply) => {
    if (req.principal?.kind !== 'admin' || req.principal.via !== 'cookie')
      return reply.code(403).send({ error: 'cookie admin requis' });
    if ((req.body as { phrase?: unknown } | null)?.phrase !== 'DÉSARMER')
      return reply.code(400).send({ error: 'phrase invalide' });
    if (!reglage.arme()) return reply.code(409).send({ error: 'confirmations non armées' });
    if (db.prepare("SELECT 1 FROM pda_appareils WHERE etat = 'actif' LIMIT 1").get()) {
      const demande = await porte.demander('desarmement', {}, req);
      if ('confirmation' in demande)
        return reply.code(202).send({ confirmation: demande.confirmation });
    }
    reglage.desarmerConfirme();
    app.log.info({}, 'pda.desarmement');
    return { ok: true };
  });
  app.put('/api/confirmations/reglage', async (req, reply) => {
    if (req.principal?.kind !== 'admin') return reply.code(403).send({ error: 'admin seulement' });
    const corps = req.body as { action?: unknown; actif?: unknown } | null;
    if (
      !corps ||
      typeof corps.action !== 'string' ||
      typeof corps.actif !== 'boolean' ||
      Object.keys(corps).some((cle) => cle !== 'action' && cle !== 'actif') ||
      !reglage.lire().some((ligne) => ligne.action === corps.action)
    )
      return reply.code(400).send({ error: 'reglage invalide' });
    if (ACTIONS_MESH.has(corps.action))
      return reply.code(400).send({ error: 'confirmation obligatoire' });
    if (!corps.actif) {
      const entree = {
        action: corps.action as
          'merge' | 'push' | 'nettoyage' | 'projet.retirer' | 'mesh.ecrire' | 'mesh.etat',
        actif: false as const,
      };
      const demande = await porte.demander('reglage', entree, req);
      if ('confirmation' in demande)
        return reply.code(202).send({ confirmation: demande.confirmation });
      await porte.executer('reglage', demande.direct, entree);
    } else reglage.rallumer(corps.action);
    return { actions: reglage.lire(), ...reglage.lireArmement() };
  });
  app.get('/api/confirmations', async (req, reply) => {
    if (req.principal?.kind !== 'admin') return reply.code(403).send({ error: 'admin seulement' });
    reply.header('Cache-Control', 'no-store');
    const champs =
      'id, action, classe, resume, etat, resultat, raison, cree_a, echeance, envoi, params, mesh';
    const avecEnvoi = (lignes: unknown[]) =>
      lignes.map((ligne) => {
        const l = ligne as Record<string, unknown>;
        const meshBrut = l.mesh;
        l.mesh = null;
        try {
          const mesh: unknown = typeof meshBrut === 'string' ? JSON.parse(meshBrut) : null;
          if (mesh && typeof mesh === 'object' && !Array.isArray(mesh)) {
            const { nom, cell } = mesh as Record<string, unknown>;
            if (typeof nom === 'string' && typeof cell === 'string') l.mesh = { nom, cell };
          }
        } catch {
          // Une colonne illisible ne doit exposer aucune empreinte.
        }
        try {
          const params: unknown = typeof l.params === 'string' ? JSON.parse(l.params) : null;
          l.params =
            params !== null && typeof params === 'object' && !Array.isArray(params) ? params : null;
        } catch {
          l.params = null;
        }
        if (!ACTIONS_MESH.has(String(l.action))) {
          delete l.envoi;
          return l;
        }
        return { ...l, envoi: typeof l.envoi === 'string' ? JSON.parse(l.envoi) : null };
      });
    return {
      ouvertes: avecEnvoi(
        db
          .prepare(
            `SELECT ${champs} FROM pda_demandes WHERE etat = 'ouverte' ORDER BY cree_a DESC, id DESC`,
          )
          .all(),
      ),
      recentes: avecEnvoi(
        db
          .prepare(
            `SELECT ${champs} FROM pda_demandes WHERE etat != 'ouverte' ORDER BY COALESCE(consomme_a, cree_a) DESC, id DESC LIMIT 20`,
          )
          .all(),
      ),
    };
  });
  app.delete('/api/confirmations/:id', async (req, reply) => {
    if (req.principal?.kind !== 'admin') return reply.code(403).send({ error: 'admin seulement' });
    const { id } = req.params as { id: string };
    const filePda = file();
    const annulee = filePda
      ? await filePda.annuler(id)
      : db
          .prepare(
            "UPDATE pda_demandes SET etat = 'expiree', resultat = 'annulee', consomme_a = ? WHERE id = ? AND etat = 'ouverte'",
          )
          .run(new Date().toISOString(), id).changes === 1;
    if (!annulee) return reply.code(409).send({ error: 'demande non ouverte' });
    return reply.code(204).send();
  });
  app.get('/api/confirmations/:id/numero', async (req, reply) => {
    if (req.principal?.kind !== 'admin' || req.principal.via !== 'cookie')
      return reply.code(403).send({ error: 'cookie admin requis' });
    reply.header('Cache-Control', 'no-store');
    const { id } = req.params as { id: string };
    const ligne = db
      .prepare(
        "SELECT numero_mac AS numero FROM pda_demandes WHERE id = ? AND classe = 'toujours' AND etat = 'ouverte' AND echeance > ?",
      )
      .get(id, Date.now());
    if (!ligne) return reply.code(404).send({ error: 'demande inconnue' });
    return ligne;
  });
}
