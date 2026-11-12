import type { ParamsAction } from '../../shared/pda.js';
import { AidHttpError } from '../errors.js';
import type { ServicesMesh } from './registre.js';

/** Relecture dans le seul jeu de services choisi par la porte, sans cache. */
export async function verifierCibleMesh(services: ServicesMesh, demande: ParamsAction) {
  let carte: number | undefined;
  let pairs: string[] = [];
  if (demande.action === 'mesh.ecrire') {
    const ecriture = demande.params;
    if (ecriture.action === 'carte.note') {
      carte = ecriture.params.carte;
      if (ecriture.params.a) pairs = [ecriture.params.a];
    }
    if (ecriture.action === 'dm.envoyer') pairs = [ecriture.params.pair];
  }
  if (demande.action === 'mesh.avis') {
    carte = demande.params.params.carte;
    pairs = demande.params.params.sieges.map((s) => s.peer);
  }
  if (carte !== undefined) {
    const fiche = await services.board.card(carte, { fresh: true, sansCache: true });
    if (!fiche.card.ok) throw new AidHttpError(409, 'perime');
  }
  if (pairs.length) {
    const resultat = await services.swarph.peers({ fresh: true, sansCache: true });
    if (!resultat.ok || pairs.some((nom) => !resultat.data.some((p) => p.nom === nom)))
      throw new AidHttpError(409, 'perime');
  }
}
