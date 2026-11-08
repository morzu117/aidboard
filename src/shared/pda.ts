export const CONTEXTE_DEMANDE = 'aid-pda-demande-v1\n';
export const CONTEXTE_RELAIS = 'aid-pda-relais-v1\n';

export function octetsRequeteRelais(requete: {
  methode: string;
  chemin: string;
  hachageCorps: string;
  heure: string;
}): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    `${CONTEXTE_RELAIS}${requete.methode}\n${requete.chemin}\n${requete.hachageCorps}\n${requete.heure}`,
  );
}

/** JSON déterministe, indépendant de Node et sans conversion implicite de valeurs. */
export function jsonCanonique(valeur: unknown): string {
  const actifs = new Set<object>();
  function encoder(v: unknown): string {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
    if (typeof v === 'number' && Number.isSafeInteger(v)) return JSON.stringify(v);
    if (typeof v !== 'object' || v === null || actifs.has(v)) throw new Error('Valeur non JSON');
    const prototype = Object.getPrototypeOf(v);
    if (!Array.isArray(v) && prototype !== Object.prototype && prototype !== null)
      throw new Error('Objet non JSON');
    if (Object.getOwnPropertySymbols(v).length) throw new Error('Clé non JSON');
    actifs.add(v);
    try {
      if (Array.isArray(v)) {
        if (Object.keys(v).length !== v.length) throw new Error('Tableau non JSON');
        return `[${Array.from(v, encoder).join(',')}]`;
      }
      return `{${Object.keys(v)
        .sort()
        .map((cle) => `${JSON.stringify(cle)}:${encoder((v as Record<string, unknown>)[cle])}`)
        .join(',')}}`;
    } finally {
      actifs.delete(v);
    }
  }
  return encoder(valeur);
}

export interface CorpsDemande {
  v: 1;
  id: string;
  action: 'essai';
  sujet: string;
  numero: string;
  echeance: number;
  emise: number;
}
export interface Enveloppe {
  corps: string;
  sig: string;
}

export function encoderBase64url(octets: Uint8Array): string {
  return btoa(String.fromCharCode(...octets))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

export function decoderBase64url(texte: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(texte)) throw new Error('Base64url invalide');
  const octets = Uint8Array.from(atob(texte.replaceAll('-', '+').replaceAll('_', '/')), (c) =>
    c.charCodeAt(0),
  );
  if (encoderBase64url(octets) !== texte) throw new Error('Base64url non canonique');
  return octets;
}

export function lireCorpsDemande(octets: Uint8Array): CorpsDemande {
  if (octets.byteLength > 16 * 1024) throw new Error('Demande trop grande');
  const o: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(octets));
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('Demande invalide');
  const c = o as Record<string, unknown>;
  const cles = ['v', 'id', 'action', 'sujet', 'numero', 'echeance', 'emise'];
  if (
    Object.keys(c).length !== cles.length ||
    !cles.every((cle) => Object.hasOwn(c, cle)) ||
    c.v !== 1 ||
    c.action !== 'essai' ||
    typeof c.id !== 'string' ||
    decoderBase64url(c.id).length !== 16 ||
    typeof c.sujet !== 'string' ||
    Array.from(c.sujet).length > 80 ||
    typeof c.numero !== 'string' ||
    !/^\d{4}$/.test(c.numero) ||
    !Number.isSafeInteger(c.echeance) ||
    !Number.isSafeInteger(c.emise)
  )
    throw new Error('Demande invalide');
  return c as unknown as CorpsDemande;
}

export async function hacher(octets: Uint8Array): Promise<string> {
  return encoderBase64url(
    new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(octets))),
  );
}

export async function defiReponse(reponse: {
  id: string;
  hDemande: string;
  numero: string;
  valeur: 'oui' | 'non';
  echeance: number;
  appareil: string;
}): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(
    await globalThis.crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(
        jsonCanonique({ ...reponse, numero: reponse.valeur === 'non' ? '' : reponse.numero }),
      ),
    ),
  );
}

export async function verifierEnveloppe(
  enveloppe: Enveloppe,
  cleRaw: string,
): Promise<CorpsDemande | null> {
  let corps: Uint8Array<ArrayBuffer>;
  try {
    if (enveloppe.corps.length > Math.ceil((16 * 1024 * 4) / 3) || enveloppe.sig.length !== 86)
      return null;
    corps = decoderBase64url(enveloppe.corps);
    const cle = await globalThis.crypto.subtle.importKey(
      'raw',
      decoderBase64url(cleRaw),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    if (
      !(await globalThis.crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        cle,
        decoderBase64url(enveloppe.sig),
        new Uint8Array([...new TextEncoder().encode(CONTEXTE_DEMANDE), ...corps]),
      ))
    )
      return null;
    return lireCorpsDemande(corps);
  } catch {
    return null;
  }
}

export interface ClesPda {
  credId: string;
  passkey: string;
  relais: { crv: string; kty: string; x: string; y: string };
}

/** Les 40 premiers bits du hachage, en base32 RFC 4648. */
export async function empreintePda({ credId, passkey, relais }: ClesPda): Promise<string> {
  const { crv, kty, x, y } = relais;
  const h = new Uint8Array(
    await globalThis.crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(jsonCanonique({ credId, passkey, relais: { crv, kty, x, y } })),
    ),
  );
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let valeur = 0;
  let texte = '';
  for (const octet of h.slice(0, 5)) {
    valeur = (valeur << 8) | octet;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      texte += alphabet[(valeur >>> bits) & 31];
    }
  }
  return `${texte.slice(0, 4)}-${texte.slice(4)}`;
}
