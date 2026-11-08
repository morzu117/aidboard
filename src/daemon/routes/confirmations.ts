import type { FastifyInstance } from 'fastify';
import type { Db } from '../db.js';
import { creerReglage } from '../confirmations/reglage.js';

// Enregistrées uniquement sur le port du Mac.
export function registerConfirmationRoutes(app: FastifyInstance, db: Db): void {
  const reglage = creerReglage(db);
  app.get('/api/confirmations/reglage', async (req, reply) => {
    if (req.principal?.kind !== 'admin') return reply.code(403).send({ error: 'admin seulement' });
    return { actions: reglage.lire(), ...reglage.lireArmement() };
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
    if (!corps.actif) return reply.code(501).send({ error: 'confirmation_requise' });
    reglage.rallumer(corps.action);
    return { actions: reglage.lire(), ...reglage.lireArmement() };
  });
}
