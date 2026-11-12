import {
  decoderBase64url,
  encoderBase64url,
  defiReponse,
  hacher,
  octetsRequeteRelais,
  signatureBasse,
  verifierEnveloppe,
  verifierResultat,
  type CorpsResultatV1,
  type CorpsDemande,
} from '../../../src/shared/pda.js';

export interface PdaLocal {
  id: string;
  credId: string;
  cleRelais: CryptoKey;
}
export interface CodePda {
  CLE_DAEMON: string;
  RELAIS: string | null;
}
export function chargerCodePda(): Promise<CodePda> {
  const chemin = '/pda-cle.js';
  return import(/* @vite-ignore */ chemin);
}
export function stockagePda(valeur?: PdaLocal): Promise<PdaLocal | null> {
  return new Promise((resolve, reject) => {
    const ouverture = indexedDB.open('aid-pda', 1);
    ouverture.onupgradeneeded = () => ouverture.result.createObjectStore('pda');
    ouverture.onerror = ouverture.onblocked = () => reject(new Error('Stockage indisponible'));
    ouverture.onsuccess = () => {
      const base = ouverture.result;
      try {
        const transaction = base.transaction('pda', valeur ? 'readwrite' : 'readonly');
        const magasin = transaction.objectStore('pda');
        const requete = valeur ? magasin.put(valeur, 'appareil') : magasin.get('appareil');
        transaction.oncomplete = () => {
          base.close();
          resolve(valeur ?? requete.result ?? null);
        };
        transaction.onerror = transaction.onabort = () => {
          base.close();
          reject(new Error('Stockage indisponible'));
        };
      } catch (erreur) {
        base.close();
        reject(erreur);
      }
    };
  });
}
let derniereHeure = 0;
export async function requeteRelais(
  relais: string,
  appareil: PdaLocal,
  chemin: string,
  contenu?: unknown,
) {
  const methode = contenu === undefined ? 'GET' : 'POST';
  const corps = contenu === undefined ? '' : JSON.stringify(contenu);
  const heure = String((derniereHeure = Math.max(Date.now(), derniereHeure + 1)));
  const signature = signatureBasse(
    new Uint8Array(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        appareil.cleRelais,
        octetsRequeteRelais({
          methode,
          chemin,
          heure,
          hachageCorps: await hacher(new TextEncoder().encode(corps)),
        }),
      ),
    ),
  );
  const reponse = await fetch(`${relais}${chemin}`, {
    method: methode,
    credentials: 'omit',
    redirect: 'error',
    cache: 'no-store',
    headers: {
      'X-Aid-Heure': heure,
      'X-Aid-Sig': encoderBase64url(signature),
      'X-Aid-Appareil': appareil.id,
      ...(contenu === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(contenu === undefined ? {} : { body: corps }),
  });
  if (!reponse.ok)
    throw new Error(
      reponse.status === 401
        ? "Cet appareil n'est pas encore activé sur le Mac, ou il a été révoqué"
        : reponse.status === 429
          ? 'Trop de demandes. Réessaie plus tard.'
          : 'Relais injoignable',
    );
  return reponse;
}
export interface DemandePda {
  demande: CorpsDemande;
  corps: string;
}
export async function lireDemandes(reponse: Response, cle: string) {
  const lecteur = reponse.body?.getReader();
  if (!lecteur) throw new Error('Réponse illisible');
  const morceaux: Uint8Array[] = [];
  let taille = 0;
  try {
    for (;;) {
      const { done, value } = await lecteur.read();
      if (done) break;
      taille += value.length;
      if (taille > 64 * 1024) throw new Error('Réponse trop grande');
      morceaux.push(value);
    }
  } finally {
    await lecteur.cancel();
    lecteur.releaseLock();
  }
  const octets = new Uint8Array(taille);
  let position = 0;
  for (const morceau of morceaux) {
    octets.set(morceau, position);
    position += morceau.length;
  }
  const liste: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(octets));
  if (!Array.isArray(liste) || liste.length > 32) throw new Error('Réponse illisible');
  const demandes: DemandePda[] = [];
  let illisibles = 0;
  for (const enveloppe of liste) {
    const demande = await verifierEnveloppe(enveloppe, cle);
    if (!demande) illisibles++;
    else if (demande.echeance > Date.now()) demandes.push({ demande, corps: enveloppe.corps });
  }
  return { demandes, illisibles };
}
export async function fabriquerReponse(
  entree: DemandePda,
  appareil: PdaLocal,
  valeur: 'oui' | 'non',
  numero: string,
) {
  const { demande, corps } = entree;
  const challenge = await defiReponse({
    id: demande.id,
    hDemande: await hacher(decoderBase64url(corps)),
    numero: valeur === 'non' ? '' : numero,
    valeur,
    echeance: demande.echeance,
    appareil: appareil.id,
  });
  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge,
      rpId: location.hostname,
      allowCredentials: [{ type: 'public-key', id: decoderBase64url(appareil.credId) }],
      userVerification: 'required',
      timeout: 60000,
    },
  })) as PublicKeyCredential | null;
  if (!assertion) throw new DOMException('Annulée', 'NotAllowedError');
  const reponse = assertion.response as AuthenticatorAssertionResponse;
  const encoder = (valeur: ArrayBuffer) => encoderBase64url(new Uint8Array(valeur));
  return {
    appareil: appareil.id,
    demande: demande.id,
    rawId: encoder(assertion.rawId),
    authenticatorData: encoder(reponse.authenticatorData),
    clientDataJSON: encoder(reponse.clientDataJSON),
    signature: encoder(reponse.signature),
    valeur,
    numero: valeur === 'non' ? null : numero,
  };
}

export async function lireResultats(
  relais: string,
  appareil: PdaLocal,
  cle: string,
): Promise<CorpsResultatV1[] | null> {
  try {
    const reponse = await requeteRelais(relais, appareil, '/resultats');
    const lecteur = reponse.body?.getReader();
    if (!lecteur) return null;
    const morceaux: Uint8Array[] = [];
    let taille = 0;
    try {
      for (;;) {
        const { done, value } = await lecteur.read();
        if (done) break;
        taille += value.length;
        if (taille > 64 * 1024) return null;
        morceaux.push(value);
      }
    } finally {
      await lecteur.cancel();
      lecteur.releaseLock();
    }
    const octets = new Uint8Array(taille);
    let position = 0;
    for (const morceau of morceaux) {
      octets.set(morceau, position);
      position += morceau.length;
    }
    const liste = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(octets));
    if (
      !liste ||
      typeof liste !== 'object' ||
      Array.isArray(liste) ||
      Object.keys(liste).join() !== 'resultats' ||
      !Array.isArray(liste.resultats) ||
      liste.resultats.length > 50
    )
      return null;
    const resultats: CorpsResultatV1[] = [];
    for (const enveloppe of liste.resultats) {
      const corps = await verifierResultat(enveloppe, cle);
      if (corps) resultats.push(corps);
    }
    return resultats;
  } catch {
    return null;
  }
}
