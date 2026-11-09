export const ISSUES_CLOTURE = ['pass', 'fail', 'cannot_evaluate', 'skipped'] as const;
export type IssueCloture = (typeof ISSUES_CLOTURE)[number];
interface CibleEtat {
  carte: number;
  obligation: number;
  attendu: { status: 'open' };
}
export interface ParametresEtat {
  'obligation.prendre': CibleEtat;
  'obligation.refuser': CibleEtat;
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
function validerPreuve(v: unknown, champ: string): string | null {
  if (typeof v !== 'string') return `${champ} invalide`;
  if (!v.trim()) return `${champ} vide`;
  if (Array.from(v).length > 4000) return `${champ} trop longue (4 000 caractères au plus)`;
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
        const message = validerPreuve(brut.preuves[cle], 'texte de preuves');
        if (message) return refus(message);
      }
    }
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
    ...('preuve' in params && params.preuve !== undefined ? [params.preuve] : []),
    ...('preuves' in params && params.preuves ? Object.values(params.preuves) : []),
  ];
}
