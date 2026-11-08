import { randomBytes, randomInt, sign } from 'node:crypto';
import {
  CONTEXTE_DEMANDE,
  hacher,
  jsonCanonique,
  lireCorpsDemande,
  type CorpsDemande,
} from '../../shared/pda.js';
import { creerFournisseurClePda } from './cle.js';

/** Le fournisseur partagé reste attaché à cette instance du daemon. */
export async function signerDemande(
  {
    action,
    sujet,
    maintenant,
  }: {
    action: 'essai';
    sujet: string;
    maintenant: number;
  },
  fournisseur: ReturnType<typeof creerFournisseurClePda>,
) {
  const corps: CorpsDemande = {
    v: 1,
    id: randomBytes(16).toString('base64url'),
    action,
    sujet,
    numero: randomInt(10000).toString().padStart(4, '0'),
    echeance: maintenant + 5 * 60 * 1000,
    emise: maintenant,
  };
  const octets = Buffer.from(jsonCanonique(corps), 'utf8');
  lireCorpsDemande(octets);
  const sig = sign('sha256', Buffer.concat([Buffer.from(CONTEXTE_DEMANDE), octets]), {
    key: fournisseur.obtenir(),
    dsaEncoding: 'ieee-p1363',
  });
  return {
    corps,
    enveloppe: { corps: octets.toString('base64url'), sig: sig.toString('base64url') },
    hDemande: await hacher(octets),
  };
}

export function creerSigneurDemande(fournisseur: ReturnType<typeof creerFournisseurClePda>) {
  return (demande: Parameters<typeof signerDemande>[0]) => signerDemande(demande, fournisseur);
}
