import { createHash, createPublicKey, timingSafeEqual, verify } from 'node:crypto';
import { decoderBase64url, defiReponse } from '../../shared/pda.js';

interface ContexteAssertion {
  appareil: { id: string; credId: string; clePublique: string; actif: boolean } | null;
  demande: { id: string; hDemande: string; numero: string | null; echeance: number };
  numeroAttendu?: string;
  origine: string;
  rpId: string;
  maintenant: number;
}

const hacher = (octets: string | Uint8Array) => createHash('sha256').update(octets).digest();
const egaux = (a: Uint8Array, b: Uint8Array) => a.length === b.length && timingSafeEqual(a, b);

/** Vérification fermée, dans l'ordre de D218 ; aucune consommation ici. */
export async function verifierAssertion(
  entree: unknown,
  ctx: ContexteAssertion,
): Promise<{ ok: true; valeur: 'oui' | 'non' } | { ok: false; raison: string }> {
  const refus = (raison: string) => ({ ok: false as const, raison });
  let taille: number;
  try {
    taille = Buffer.byteLength(JSON.stringify(entree));
  } catch {
    return refus('schema');
  }
  if (taille > 8192) return refus('taille');
  if (!entree || typeof entree !== 'object' || Array.isArray(entree)) return refus('schema');
  const e = entree as Record<string, unknown>;
  const champs = [
    'appareil',
    'demande',
    'rawId',
    'authenticatorData',
    'clientDataJSON',
    'signature',
    'valeur',
  ];
  if (
    !champs.every((champ) => Object.hasOwn(e, champ) && typeof e[champ] === 'string') ||
    Object.keys(e).some((champ) => ![...champs, 'numero'].includes(champ)) ||
    (e.valeur !== 'oui' && e.valeur !== 'non') ||
    (e.numero !== undefined && e.numero !== null && typeof e.numero !== 'string')
  )
    return refus('schema');
  let rawId: Uint8Array;
  let authentificateur: Uint8Array;
  let client: Uint8Array;
  let signature: Uint8Array;
  try {
    rawId = decoderBase64url(e.rawId as string);
    authentificateur = decoderBase64url(e.authenticatorData as string);
    client = decoderBase64url(e.clientDataJSON as string);
    signature = decoderBase64url(e.signature as string);
  } catch {
    return refus('schema');
  }
  if (client.length > 2048 || authentificateur.length > 512 || signature.length > 72)
    return refus('taille');
  if (authentificateur.length < 37 || !rawId.length || !signature.length) return refus('schema');
  const appareil = ctx.appareil;
  if (
    !appareil ||
    !appareil.actif ||
    appareil.id !== e.appareil ||
    appareil.credId !== e.rawId ||
    e.demande !== ctx.demande.id
  )
    return refus('appareil');
  let cle;
  try {
    cle = createPublicKey({
      key: Buffer.from(decoderBase64url(appareil.clePublique)),
      format: 'der',
      type: 'spki',
    });
    if (cle.asymmetricKeyType !== 'ec' || cle.asymmetricKeyDetails?.namedCurve !== 'prime256v1')
      return refus('algorithme');
  } catch {
    return refus('algorithme');
  }
  let donnees: Record<string, unknown>;
  try {
    const objet: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(client));
    if (!objet || typeof objet !== 'object' || Array.isArray(objet)) return refus('client');
    donnees = objet as Record<string, unknown>;
    if (
      donnees.type !== 'webauthn.get' ||
      donnees.origin !== ctx.origine ||
      (donnees.crossOrigin !== undefined && donnees.crossOrigin !== false)
    )
      return refus('client');
  } catch {
    return refus('client');
  }
  if (!egaux(authentificateur.subarray(0, 32), hacher(ctx.rpId))) return refus('rpid');
  if ((authentificateur[32]! & 5) !== 5) return refus('presence');
  const numeroAttendu = ctx.demande.numero ?? ctx.numeroAttendu;
  if (
    ctx.demande.numero === null &&
    (numeroAttendu?.length !== 4 || !/^\d{4}$/.test(numeroAttendu))
  )
    return refus('numero');
  if (
    e.valeur === 'oui'
      ? e.numero !== (ctx.demande.numero ?? ctx.numeroAttendu)
      : e.numero !== undefined && e.numero !== null
  )
    return refus('numero');
  try {
    if (
      typeof donnees.challenge !== 'string' ||
      !egaux(
        decoderBase64url(donnees.challenge),
        await defiReponse({
          ...ctx.demande,
          appareil: appareil.id,
          valeur: e.valeur,
          numero: e.valeur === 'non' ? '' : (e.numero as string),
        }),
      )
    )
      return refus('defi');
  } catch {
    return refus('defi');
  }
  try {
    if (!verify('sha256', Buffer.concat([authentificateur, hacher(client)]), cle, signature))
      return refus('signature');
  } catch {
    return refus('signature');
  }
  if (!(ctx.maintenant <= ctx.demande.echeance)) return refus('echeance');
  return { ok: true, valeur: e.valeur };
}
