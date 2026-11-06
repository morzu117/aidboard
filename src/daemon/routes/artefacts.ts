import { extname } from 'node:path';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { EtatArtefacts, LienArtefact } from '../../shared/artefacts.js';
import type { JetonsArtefacts, TypeArtefact } from '../artefacts/jetons.js';
import type { Db } from '../db.js';
import { AidHttpError } from '../errors.js';
import { readTopicFile } from './files.js';

// Chantier 30 : les routes des artefacts sur le port PRINCIPAL, authentifiées comme le reste.
// Le second port (artefacts/serveur.ts) ne sert que ce que ces routes ont émis.

export interface ArtefactsDeps {
  jetons: JetonsArtefacts;
  /** l'état du second port, fixé au démarrage du daemon */
  etat: () => EtatArtefacts;
}

const LienBody = Type.Object(
  { path: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

/** Les types servis par le second port ; un `.md` se rend dans la page (D167). */
export function typeServi(path: string): TypeArtefact | null {
  const ext = extname(path).toLowerCase();
  if (ext === '.html' || ext === '.htm') return 'html';
  if (ext === '.svg') return 'svg';
  return null;
}

export function registerArtefactRoutes(
  app: FastifyInstance,
  deps: { db: Db; artefacts?: ArtefactsDeps },
): void {
  const etat = (): EtatArtefacts =>
    deps.artefacts?.etat() ?? { disponible: false, port: null, raison: 'non démarré' };

  app.get('/api/artefacts/etat', async () => etat());

  app.post('/api/topics/:id/artefacts/lien', { schema: { body: LienBody } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { path } = req.body as { path: string };
    const e = etat();
    if (!deps.artefacts || !e.disponible || e.port === null) {
      throw new AidHttpError(503, `Artefacts indisponibles : ${e.raison ?? 'port fermé'}`);
    }
    const type = typeServi(path);
    if (!type) throw new AidHttpError(422, `${path} n'est pas un artefact HTML ou SVG`);
    const contenu = readTopicFile(deps.db, id, path);
    const { jeton, expireA } = deps.artefacts.jetons.emettre(contenu, type);
    // le lien suit l'hôte de la page : 127.0.0.1 ou localhost (le Host est déjà vérifié)
    const hote = (req.headers.host ?? '127.0.0.1').startsWith('localhost:')
      ? 'localhost'
      : '127.0.0.1';
    reply.header('Cache-Control', 'no-store');
    return {
      url: `http://${hote}:${e.port}/a/${jeton}`,
      expireA: new Date(expireA).toISOString(),
    } satisfies LienArtefact;
  });
}
