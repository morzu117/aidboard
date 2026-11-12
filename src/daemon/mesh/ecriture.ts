import { empreinteChemin, empreinteGateway } from '../../shared/meshes.js';
import type { MeshSigne } from '../../shared/pda.js';
import type { AidConfig } from '../config.js';
import { AidHttpError } from '../errors.js';
import type { MeshRegistry } from './registre.js';

export function nomMeshEcriture(corps: unknown): string {
  const nom = (corps as { mesh?: unknown } | null)?.mesh;
  if (typeof nom !== 'string' || /^[a-z][a-z0-9-]{0,31}$/.exec(nom)?.[0] !== nom)
    throw new AidHttpError(400, 'mesh_requis');
  return nom;
}

/** Les dépendances historiques ne représentent que principal, jamais un autre nom. */
export function signatureMesh(
  deps: { meshes?: MeshRegistry; config?: AidConfig },
  nom: string,
): MeshSigne {
  if (deps.meshes) return deps.meshes.signature(nom);
  if (nom !== 'principal') throw new AidHttpError(404, 'mesh inconnu');
  const mesh = deps.config?.mesh;
  if (!mesh?.cell) throw new AidHttpError(404, 'mesh désactivé');
  if (!mesh.gateway) throw new AidHttpError(409, 'gateway_requis');
  return {
    nom,
    cell: mesh.cell,
    gateway: empreinteGateway(mesh.gateway),
    proxy: empreinteChemin(mesh.proxySocket ?? ''),
  };
}
