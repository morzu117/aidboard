export const ISSUES_CLOTURE = ['pass', 'fail', 'cannot_evaluate', 'skipped'] as const;
export type IssueCloture = (typeof ISSUES_CLOTURE)[number];
interface CibleEtat {
  carte: number;
  obligation: number;
  attendu: { status: 'open' };
}
export interface ParametresEtat {
  'obligation.prendre': CibleEtat;
  'obligation.refuser': CibleEtat & { motif: string };
  'obligation.clore': CibleEtat & {
    attendu: { status: 'open'; acceptSha256: string };
    issue: IssueCloture;
    preuve?: string;
    preuves?: Record<string, string>;
  };
}
export type ActionEtat = keyof ParametresEtat;

export async function hashAccept(accept: string | null): Promise<string> {
  const hash = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(accept ?? ''),
  );
  return Array.from(new Uint8Array(hash), (octet) => octet.toString(16).padStart(2, '0')).join('');
}

const objet = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const entier = (v: unknown): boolean => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
function validerPreuve(v: unknown, champ: string, maximum = 3900): string | null {
  if (typeof v !== 'string') return `${champ} invalide`;
  if (!v.trim()) return `${champ} vide`;
  if (Array.from(v).length > maximum)
    return `${champ} trop longue (${maximum.toLocaleString('fr-FR').replace(/\s/g, ' ')} caractères au plus)`;
  if (/\p{Cc}/u.test(v.replace(/[\n\t]/g, '')))
    return `${champ} contenant un caractère de contrôle`;
  return null;
}
export function lireParamsEtat<A extends ActionEtat>(
  action: A,
  brut: unknown,
): { ok: true; params: ParametresEtat[A] } | { ok: false; message: string } {
  const refus = (message: string) => ({ ok: false as const, message });
  if (!objet(brut)) return refus('params doit être un objet');
  if (!['obligation.prendre', 'obligation.refuser', 'obligation.clore'].includes(action))
    return refus('action inconnue');
  const cloture = action === 'obligation.clore';
  const champs = [
    'carte',
    'obligation',
    'attendu',
    ...(cloture ? ['issue', 'preuve', 'preuves'] : []),
    ...(action === 'obligation.refuser' ? ['motif'] : []),
  ];
  for (const cle of Reflect.ownKeys(brut))
    if (typeof cle !== 'string' || !champs.includes(cle))
      return refus(`clé inconnue : ${String(cle)}`);
  for (const champ of ['carte', 'obligation', 'attendu', ...(cloture ? ['issue'] : [])]) {
    if (!Object.hasOwn(brut, champ)) return refus(`champ manquant : ${champ}`);
    if (champ === 'carte' && !entier(brut.carte)) return refus('numéro de carte invalide');
    if (champ === 'obligation' && !entier(brut.obligation))
      return refus('numéro d’obligation invalide');
    if (champ === 'attendu') {
      const attendu = brut.attendu;
      if (!objet(attendu)) return refus('attendu doit être un objet');
      for (const cle of Reflect.ownKeys(attendu))
        if (cle !== 'status' && !(cloture && cle === 'acceptSha256'))
          return refus(`clé inconnue dans attendu : ${String(cle)}`);
      if (!Object.hasOwn(attendu, 'status')) return refus('champ manquant : attendu.status');
      if (attendu.status !== 'open') return refus('attendu.status doit valoir open');
      if (cloture) {
        if (!Object.hasOwn(attendu, 'acceptSha256'))
          return refus('champ manquant : attendu.acceptSha256');
        if (
          typeof attendu.acceptSha256 !== 'string' ||
          !/^[0-9a-f]{64}$/.exec(attendu.acceptSha256)?.[0] ||
          attendu.acceptSha256.length !== 64
        )
          return refus('attendu.acceptSha256 invalide');
      }
    }
    if (champ === 'issue' && !ISSUES_CLOTURE.includes(brut.issue as IssueCloture))
      return refus('issue inconnue');
  }
  if (action === 'obligation.refuser') {
    if (!Object.hasOwn(brut, 'motif')) return refus('champ manquant : motif');
    const message = validerPreuve(brut.motif, 'motif', 2000);
    if (message) return refus(message);
  }
  if (cloture) {
    if (Object.hasOwn(brut, 'preuve')) {
      const message = validerPreuve(brut.preuve, 'preuve');
      if (message) return refus(message);
    }
    if (Object.hasOwn(brut, 'preuves')) {
      if (!objet(brut.preuves)) return refus('preuves doit être un objet');
      const cles = Reflect.ownKeys(brut.preuves);
      if (cles.length > 20) return refus('preuves : 20 conditions au plus');
      for (const cle of cles) {
        if (typeof cle !== 'string' || !/^[A-Za-z0-9_.:-]{1,64}$/.test(cle) || cle.endsWith('\n'))
          return refus('identifiant de condition invalide');
        const message = validerPreuve(brut.preuves[cle], 'texte de preuves', 12000);
        if (message) return refus(message);
      }
    }
    if (objet(brut.preuves) && tailleJsonPython(brut.preuves as Record<string, string>) > 12000)
      return refus('preuves : 12 000 caractères sérialisés au plus');
    if (
      !Object.hasOwn(brut, 'preuve') &&
      (!objet(brut.preuves) || !Reflect.ownKeys(brut.preuves).length)
    )
      return refus('preuve ou preuves requise');
  }
  return { ok: true, params: { ...brut } as unknown as ParametresEtat[A] };
}

export function resumeEtat<A extends ActionEtat>(action: A, params: ParametresEtat[A]): string {
  if (!lireParamsEtat(action, params).ok) throw new Error('Paramètres d’état invalides');
  const verbe = {
    'obligation.prendre': 'Prendre',
    'obligation.refuser': 'Refuser',
    'obligation.clore': 'Clore',
  }[action];
  const issue =
    action === 'obligation.clore'
      ? ` : ${(params as ParametresEtat['obligation.clore']).issue}`
      : '';
  return `${verbe} l'obligation #${params.obligation} (carte #${params.carte})${issue}`;
}

export function textesAPurger(params: ParametresEtat[ActionEtat]): string[] {
  return [
    ...('motif' in params ? [params.motif] : []),
    ...('preuve' in params && params.preuve !== undefined ? [params.preuve] : []),
    ...('preuves' in params && params.preuves ? Object.values(params.preuves) : []),
  ];
}

/** Longueur de json.dumps(..., sort_keys=True), avec ensure_ascii=True. */
export function tailleJsonPython(objet: Record<string, string>): number {
  const tailleTexte = (texte: string) => {
    let taille = 2;
    // Les unités UTF-16 comptent aussi les deux échappements d'un caractère astral.
    for (let i = 0; i < texte.length; i++) {
      const code = texte.charCodeAt(i);
      taille +=
        code === 34 || code === 92 || [8, 9, 10, 12, 13].includes(code)
          ? 2
          : code < 32 || code > 126
            ? 6
            : 1;
    }
    return taille;
  };
  // Le tri par points de code de Python ne change pas la longueur.
  const cles = Object.keys(objet);
  return (
    2 +
    Math.max(0, cles.length - 1) * 2 +
    cles.reduce((taille, cle) => taille + tailleTexte(cle) + 2 + tailleTexte(objet[cle]!), 0)
  );
}

export type Etat = {
  [A in ActionEtat]: { action: A; params: ParametresEtat[A] };
}[ActionEtat];

export function argsEtat<A extends ActionEtat>(
  action: A,
  params: ParametresEtat[A],
): { verb: string; args: Record<string, unknown> } {
  if (!lireParamsEtat(action, params).ok) throw new Error('Paramètres d’état invalides');
  const args = { id: params.obligation, expect_status: 'open' };
  if (action === 'obligation.prendre') return { verb: 'board.obligations.take', args };
  if ('motif' in params)
    return { verb: 'board.obligations.decline', args: { ...args, why: params.motif } };
  const cloture = params as ParametresEtat['obligation.clore'];
  return {
    verb: 'board.obligations.close',
    args: {
      ...args,
      expect_accept_sha256: cloture.attendu.acceptSha256,
      outcome: cloture.issue,
      ...(cloture.preuve !== undefined && { evidence: cloture.preuve }),
      ...(cloture.preuves &&
        Object.keys(cloture.preuves).length && { evidence_json: cloture.preuves }),
    },
  };
}
