import type { FastifyInstance } from 'fastify';
import { AidHttpError } from '../errors.js';
import type { SwarphReader } from '../mesh/lectures.js';

export function registerSwarphRoutes(
  app: FastifyInstance,
  deps: { swarph: SwarphReader | null },
): void {
  const lecteur = () => {
    if (!deps.swarph)
      throw new AidHttpError(404, 'mesh désactivé : `mesh.cell` vide dans config.yaml');
    return deps.swarph;
  };
  const routes = ['cells', 'federation', 'memory', 'memory/page', 'reglages'] as const;
  for (const route of routes) {
    app.get(`/api/swarph/${route}`, async (req) => {
      const s = lecteur();
      const query = req.query as { fresh?: string; q?: string; tag?: string; slug?: string };
      const opts = { fresh: query.fresh === '1' };
      try {
        switch (route) {
          case 'cells':
            return { peers: await s.peers(opts), monitor: s.monitor() };
          case 'reglages':
            return { rights: await s.rights(opts), monitor: s.monitor() };
          case 'federation':
            return await s.codegraph(query.q ?? '', opts);
          case 'memory':
            return await s.memory(query.tag ?? '', opts);
          case 'memory/page':
            return await s.page(query.slug ?? '', opts);
        }
      } catch (err) {
        if (err instanceof RangeError) throw new AidHttpError(400, err.message);
        throw err;
      }
    });
  }
}
