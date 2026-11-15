import type { FastifyInstance } from 'fastify';
import type { Db } from '../db.js';
import type { MeshRegistry } from '../mesh/registre.js';
import { AidHttpError } from '../errors.js';
import { isBoardId } from '../mesh/board.js';
import { DepotCartesReliees } from '../cartes-reliees/depot.js';
import { CartesReliees, type CibleCarte } from '../cartes-reliees/service.js';

const objet = (valeur: unknown): Record<string, unknown> => {
  if (!valeur || typeof valeur !== 'object' || Array.isArray(valeur))
    throw new AidHttpError(400, 'corps mal formé');
  return valeur as Record<string, unknown>;
};
const cible = (valeur: unknown): CibleCarte => {
  const v = objet(valeur);
  if (typeof v.mesh !== 'string' || !v.mesh.length || !isBoardId(v.carte))
    throw new AidHttpError(400, 'membre mal formé');
  // Les champs d'identité éventuellement envoyés sont ignorés.
  return { mesh: v.mesh, carte: v.carte };
};
const note = (valeur: unknown): string | null => {
  if (valeur === null) return null;
  if (typeof valeur !== 'string' || Array.from(valeur).length > 120)
    throw new AidHttpError(400, 'note invalide (120 caractères maximum)');
  return valeur;
};
const identifiant = (valeur: string): number => {
  const nombre = /^\d+$/.test(valeur) ? Number(valeur) : NaN;
  if (!isBoardId(nombre)) throw new AidHttpError(400, 'identifiant invalide');
  return nombre;
};
const entierPagination = (valeur: unknown, defaut: number, minimum: number, maximum: number) => {
  if (valeur === undefined) return defaut;
  const nombre = typeof valeur === 'string' && /^\d+$/.test(valeur) ? Number(valeur) : NaN;
  if (!Number.isSafeInteger(nombre) || nombre < minimum || nombre > maximum)
    throw new AidHttpError(400, 'pagination invalide');
  return nombre;
};

export function registerCartesRelieesRoutes(
  app: FastifyInstance,
  deps: { db: Db; meshes?: MeshRegistry },
): void {
  const service = new CartesReliees(new DepotCartesReliees(deps.db), deps.meshes);
  app.get('/api/cartes-reliees', async (req) => {
    const query = req.query as { mesh?: string; carte?: string; limite?: string; apres?: string };
    const limite = entierPagination(query.limite, 20, 1, 50);
    const apres = entierPagination(query.apres, 0, 0, Number.MAX_SAFE_INTEGER);
    if (query.mesh === undefined && query.carte === undefined) return service.page(limite, apres);
    if (typeof query.mesh !== 'string' || typeof query.carte !== 'string')
      throw new AidHttpError(400, 'mesh et carte requis');
    return service.liste(cible({ mesh: query.mesh, carte: identifiant(query.carte) }));
  });

  // Même garde admin locale que POST /api/meshes/:nom/archiver, sans porte téléphone.
  app.register(async (ecritures) => {
    ecritures.addHook('preHandler', async (req, reply) => {
      if (req.principal?.kind !== 'admin')
        return reply.code(403).send({ error: 'admin seulement' });
    });
    ecritures.post('/api/cartes-reliees', async (req, reply) => {
      const corps = objet(req.body);
      if (!Array.isArray(corps.membres) || corps.membres.length < 2)
        throw new AidHttpError(400, 'au moins deux membres requis');
      const membres = corps.membres.map(cible);
      if (new Set(membres.map((m) => m.mesh)).size !== membres.length)
        throw new AidHttpError(400, 'deux membres sur le même mesh');
      const texte = corps.note === undefined ? null : note(corps.note);
      const id = await service.creer(membres, texte);
      return reply.code(201).send({ id });
    });
    ecritures.post('/api/cartes-reliees/:id/membres', async (req, reply) => {
      await service.ajouter(identifiant((req.params as { id: string }).id), cible(req.body));
      return reply.code(204).send();
    });
    ecritures.delete('/api/cartes-reliees/:id/membres/:membre', async (req, reply) => {
      const params = req.params as { id: string; membre: string };
      service.depot.retirer(identifiant(params.id), identifiant(params.membre));
      return reply.code(204).send();
    });
    ecritures.patch('/api/cartes-reliees/:id', async (req, reply) => {
      service.depot.noter(
        identifiant((req.params as { id: string }).id),
        note(objet(req.body).note),
      );
      return reply.code(204).send();
    });
  });
}
