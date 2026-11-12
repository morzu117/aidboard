import type { ResultatEnvoi } from './ecritures.js';
import {
  ACTIONS_MESH,
  CLASSE_ACTION,
  resumeAction,
  validerParamsAction,
  type ActionConfirmee,
  type CorpsDemandeV2,
} from './confirmations.js';
export { CLASSE_ACTION, resumeAction } from './confirmations.js';
export type {
  ActionConfirmee,
  ClasseConfirmation,
  ParamsAction,
  ParametresActions,
  CorpsDemandeV2,
} from './confirmations.js';

export const TAILLE_MAX_DEMANDE = 16 * 1024;

export const CONTEXTE_DEMANDE = 'aid-pda-demande-v1\n';
export const CONTEXTE_RELAIS = 'aid-pda-relais-v1\n';
export const CONTEXTE_RESULTAT = 'aid-pda-resultat-v1\n';

export const ORDRE_P256 = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

function lireS(sig: Uint8Array): bigint {
  if (sig.length !== 64) throw new Error('Signature r‖s attendue sur 64 octets');
  let s = 0n;
  for (const octet of sig.subarray(32)) s = (s << 8n) | BigInt(octet);
  return s;
}

export function signatureBasse(sig: Uint8Array): Uint8Array<ArrayBuffer> {
  let s = lireS(sig);
  if (s <= 0n || s >= ORDRE_P256) throw new Error('Valeur s invalide');
  if (s > ORDRE_P256 / 2n) s = ORDRE_P256 - s;
  const basse = new Uint8Array(sig);
  for (let i = 63; i >= 32; i--) {
    basse[i] = Number(s & 255n);
    s >>= 8n;
  }
  return basse;
}

export function estBasse(sig: Uint8Array): boolean {
  if (sig.length !== 64) return false;
  const s = lireS(sig);
  return s > 0n && s <= ORDRE_P256 / 2n;
}

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

export interface MeshSigne {
  nom: string;
  cell: string;
  gateway: string;
  proxy: string;
}
type ActionMesh = Extract<ActionConfirmee, `mesh.${string}`>;
export type CorpsDemandeV3 = {
  [A in ActionMesh]: Omit<Extract<CorpsDemandeV2, { action: A }>, 'v'> & { v: 3; mesh: MeshSigne };
}[ActionMesh];
export function resumeActionMesh(
  mesh: MeshSigne,
  action: ActionConfirmee,
  params: Parameters<typeof resumeAction>[1],
): string {
  return Array.from(`[${mesh.nom}] ${resumeAction(action, params)}`)
    .slice(0, 200)
    .join('');
}
export type CorpsDemande = CorpsDemandeV1 | CorpsDemandeV2 | CorpsDemandeV3;
export interface CorpsDemandeV1 {
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
  if (octets.byteLength > TAILLE_MAX_DEMANDE) throw new Error('Demande trop grande');
  const o: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(octets));
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('Demande invalide');
  const c = o as Record<string, unknown>;
  if (c.v === 3) return lireCorpsDemandeV3(c);
  if (c.v === 2) return lireCorpsDemandeV2(c);
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

export function lireCorpsDemandeV3(c: Record<string, unknown>): CorpsDemandeV3 {
  const cles = [
    'v',
    'id',
    'action',
    'classe',
    'params',
    'resume',
    'numero',
    'echeance',
    'emise',
    'mesh',
  ];
  const m = c.mesh as Record<string, unknown> | null;
  const empreinte = (v: unknown) =>
    typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v) && decoderBase64url(v).length === 32;
  if (
    c.v !== 3 ||
    Object.keys(c).length !== cles.length ||
    !cles.every((cle) => Object.hasOwn(c, cle)) ||
    typeof c.action !== 'string' ||
    !ACTIONS_MESH.has(c.action) ||
    !m ||
    typeof m !== 'object' ||
    Array.isArray(m) ||
    Object.keys(m).length !== 4 ||
    !['nom', 'cell', 'gateway', 'proxy'].every((cle) => Object.hasOwn(m, cle)) ||
    typeof m.nom !== 'string' ||
    /^[a-z][a-z0-9-]{0,31}$/.exec(m.nom)?.[0] !== m.nom ||
    typeof m.cell !== 'string' ||
    /^[^\s\p{Cc}]{1,64}$/u.exec(m.cell)?.[0] !== m.cell ||
    !empreinte(m.gateway) ||
    !empreinte(m.proxy)
  )
    throw new Error('Demande invalide');
  // La v2 valide les champs communs avec son propre résumé, sans accepter de clé mesh.
  const commun = { ...c };
  delete commun.mesh;
  lireCorpsDemandeV2({
    ...commun,
    v: 2,
    resume: resumeAction(
      c.action as ActionConfirmee,
      c.params as Parameters<typeof resumeAction>[1],
    ),
  });
  const corps = c as unknown as CorpsDemandeV3;
  if (corps.resume !== resumeActionMesh(corps.mesh, corps.action, corps.params))
    throw new Error('Résumé invalide');
  return corps;
}

function lireCorpsDemandeV2(c: Record<string, unknown>): CorpsDemandeV2 {
  const cles = ['v', 'id', 'action', 'classe', 'params', 'resume', 'numero', 'echeance', 'emise'];
  if (
    Object.keys(c).length !== cles.length ||
    !cles.every((cle) => Object.hasOwn(c, cle)) ||
    typeof c.id !== 'string' ||
    decoderBase64url(c.id).length !== 16 ||
    typeof c.action !== 'string' ||
    !Object.hasOwn(CLASSE_ACTION, c.action) ||
    c.classe !== CLASSE_ACTION[c.action as ActionConfirmee] ||
    !validerParamsAction(c.action as ActionConfirmee, c.params) ||
    (c.classe === 'toujours'
      ? c.numero !== null
      : typeof c.numero !== 'string' || c.numero.length !== 4 || !/^\d{4}$/.test(c.numero)) ||
    typeof c.resume !== 'string' ||
    Array.from(c.resume).length > 160 ||
    !Number.isSafeInteger(c.echeance) ||
    !Number.isSafeInteger(c.emise) ||
    (c.echeance as number) < (c.emise as number) ||
    (c.echeance as number) - (c.emise as number) > 15 * 60_000
  )
    throw new Error('Demande invalide');
  const corps = c as unknown as CorpsDemandeV2;
  if (corps.resume !== resumeAction(corps.action, corps.params)) throw new Error('Résumé invalide');
  return corps;
}

export const RESULTATS_PDA = ['executee', 'echouee', 'perimee', 'annulee'] as const;
export const RAISONS_RESULTAT = ['perime', 'delai', 'script', 'numero'] as const;
export const CODES_RESULTAT = [
  'succes',
  'verb_not_allowed',
  'bad_args',
  'peer_not_allowed',
  'proxy_unavailable',
  'upstream_unreachable',
  'upstream_ambiguous',
  'upstream_error',
  'delai',
  'interrompu',
  'connexion',
  'format',
  'obligation-close',
] as const satisfies readonly ResultatEnvoi['code'][];
// Une évolution de l'énumération d'envoi doit aussi fermer la liste du résultat signé.
const codesComplets: Exclude<ResultatEnvoi['code'], (typeof CODES_RESULTAT)[number]> extends never
  ? true
  : never = true;

export interface CorpsResultatV1 {
  v: 1;
  id: string;
  action: ActionConfirmee;
  resultat: (typeof RESULTATS_PDA)[number];
  raison: (typeof RAISONS_RESULTAT)[number] | null;
  code: ResultatEnvoi['code'] | null;
  emis: number;
}

function lireCorpsResultat(octets: Uint8Array): CorpsResultatV1 {
  const c = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(octets));
  if (
    !c ||
    typeof c !== 'object' ||
    Array.isArray(c) ||
    Object.keys(c).sort().join(',') !== 'action,code,emis,id,raison,resultat,v' ||
    c.v !== 1 ||
    typeof c.id !== 'string' ||
    !/^[A-Za-z0-9_-]{22}$/.test(c.id) ||
    decoderBase64url(c.id).length !== 16 ||
    typeof c.action !== 'string' ||
    !Object.hasOwn(CLASSE_ACTION, c.action) ||
    !RESULTATS_PDA.includes(c.resultat) ||
    (c.raison !== null && !RAISONS_RESULTAT.includes(c.raison)) ||
    (c.code !== null && !CODES_RESULTAT.includes(c.code)) ||
    !codesComplets ||
    !Number.isSafeInteger(c.emis) ||
    jsonCanonique(c) !== new TextDecoder().decode(octets)
  )
    throw new Error('Résultat invalide');
  return c;
}

/** La signature est injectée par le daemon : aucune clé privée dans le code du téléphone. */
export function signerResultat(
  entree: unknown,
  signer: (octets: Uint8Array) => Uint8Array,
): Enveloppe | null {
  try {
    const corps = new TextEncoder().encode(jsonCanonique(entree));
    lireCorpsResultat(corps);
    const sig = signer(new Uint8Array([...new TextEncoder().encode(CONTEXTE_RESULTAT), ...corps]));
    return { corps: encoderBase64url(corps), sig: encoderBase64url(sig) };
  } catch {
    return null;
  }
}

export async function verifierResultat(
  enveloppe: Enveloppe,
  cleRaw: string,
): Promise<CorpsResultatV1 | null> {
  try {
    if (enveloppe.corps.length > 1024 || enveloppe.sig.length !== 86) return null;
    const corps = decoderBase64url(enveloppe.corps);
    const resultat = lireCorpsResultat(corps);
    const cle = await globalThis.crypto.subtle.importKey(
      'raw',
      decoderBase64url(cleRaw),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    return (await globalThis.crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      cle,
      decoderBase64url(enveloppe.sig),
      new Uint8Array([...new TextEncoder().encode(CONTEXTE_RESULTAT), ...corps]),
    ))
      ? resultat
      : null;
  } catch {
    return null;
  }
}
