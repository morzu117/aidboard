import { ACTIONS_MESH } from '../../shared/confirmations.js';
import { randomBytes, randomInt, sign } from 'node:crypto';
import {
  CONTEXTE_DEMANDE,
  TAILLE_MAX_DEMANDE,
  hacher,
  jsonCanonique,
  lireCorpsDemande,
  type CorpsDemande,
  CLASSE_ACTION,
  resumeAction,
  resumeActionMesh,
  type MeshSigne,
  type CorpsDemandeV3,
  type ParamsAction,
  type CorpsDemandeV2,
  type CorpsDemandeV1,
} from '../../shared/pda.js';
import { creerFournisseurClePda } from './cle.js';

export class DemandeTropGrande extends Error {
  constructor() {
    super('Demande trop grande');
  }
}

type EntreeV1 = { action: 'essai'; sujet: string; maintenant: number };
type EntreeSignee = EntreeV1 | (ParamsAction & { maintenant: number; mesh?: MeshSigne });
interface DemandeSignee<C extends CorpsDemande> {
  corps: C;
  numeroMac: string | null;
  enveloppe: { corps: string; sig: string };
  hDemande: string;
}
export function signerDemande(
  entree: EntreeV1,
  fournisseur: ReturnType<typeof creerFournisseurClePda>,
): Promise<DemandeSignee<CorpsDemandeV1>>;
export function signerDemande(
  entree: EntreeSignee,
  fournisseur: ReturnType<typeof creerFournisseurClePda>,
): Promise<DemandeSignee<CorpsDemande>>;
/** Le fournisseur partagé reste attaché à cette instance du daemon. */
export async function signerDemande(
  entree: ({ action: 'essai'; sujet: string } | ParamsAction) & {
    maintenant: number;
    mesh?: MeshSigne;
  },
  fournisseur: ReturnType<typeof creerFournisseurClePda>,
) {
  const { action, maintenant } = entree;
  const mesh = entree.mesh;
  if (ACTIONS_MESH.has(action) && !mesh) throw new Error('mesh_requis');
  const numero = randomInt(10000).toString().padStart(4, '0');
  const corps: CorpsDemande =
    'sujet' in entree
      ? {
          v: 1,
          id: randomBytes(16).toString('base64url'),
          action: entree.action,
          sujet: entree.sujet,
          numero,
          echeance: maintenant + 5 * 60 * 1000,
          emise: maintenant,
        }
      : ({
          v: ACTIONS_MESH.has(action) ? 3 : 2,
          ...(ACTIONS_MESH.has(action) && { mesh }),
          id: randomBytes(16).toString('base64url'),
          action,
          classe: CLASSE_ACTION[action],
          params: entree.params,
          resume: ACTIONS_MESH.has(action)
            ? resumeActionMesh(mesh!, action, entree.params)
            : resumeAction(action, entree.params),
          numero: CLASSE_ACTION[action] === 'toujours' ? null : numero,
          echeance: maintenant + 15 * 60_000,
          emise: maintenant,
        } as CorpsDemandeV2 | CorpsDemandeV3);
  const octets = Buffer.from(jsonCanonique(corps), 'utf8');
  if (octets.byteLength > TAILLE_MAX_DEMANDE) throw new DemandeTropGrande();
  lireCorpsDemande(octets);
  const sig = sign('sha256', Buffer.concat([Buffer.from(CONTEXTE_DEMANDE), octets]), {
    key: fournisseur.obtenir(),
    dsaEncoding: 'ieee-p1363',
  });
  return {
    corps,
    numeroMac: corps.numero === null ? numero : null,
    enveloppe: { corps: octets.toString('base64url'), sig: sig.toString('base64url') },
    hDemande: await hacher(octets),
  };
}

export function creerSigneurDemande(fournisseur: ReturnType<typeof creerFournisseurClePda>) {
  return <E extends EntreeSignee>(demande: E) =>
    signerDemande(demande, fournisseur) as Promise<
      DemandeSignee<E extends EntreeV1 ? CorpsDemandeV1 : CorpsDemandeV2 | CorpsDemandeV3>
    >;
}
