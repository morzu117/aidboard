/**
 * Chantier 20 (DM1) : détecteur de secrets dans le texte libre — clés privées, identifiants d'URL, jetons à
 * préfixe connu. Le masquage est irréversible et idempotent : A-I-D ne garde jamais l'original (D76), et un
 * texte déjà masqué repasse sans changer.
 */
export const MASK = '[secret masqué]';

/** Bloc de clé privée jusqu'à son `END`, ou jusqu'à la fin du texte s'il a été coupé. */
const PRIVATE_KEY =
  /-----BEGIN ([A-Z0-9]+ )*PRIVATE KEY( BLOCK)?-----[\s\S]*?(-----END ([A-Z0-9]+ )*PRIVATE KEY( BLOCK)?-----|$)/g;

/** `schéma://userinfo@` : jusqu'au dernier `@` avant l'hôte, un mot de passe peut en contenir un. */
const USERINFO = /([a-z][a-z0-9+.-]*:\/\/)([^\s/]+)@/gi;

/**
 * Jetons à préfixe connu : le préfixe reste (il dit de quoi il s'agit), le reste disparaît. Une longueur minimale
 * par famille écarte les mots ordinaires (`task-list`, `sk-learn`).
 */
const TOKENS: readonly RegExp[] = [
  /\b(gh[pousr]_)[A-Za-z0-9]{36,}\b/g,
  /\b(github_pat_)[A-Za-z0-9_]{22,}/g,
  /\b(glpat-)[A-Za-z0-9_-]{20,}/g,
  /\b(xox[abposr]-)[A-Za-z0-9-]{10,}/g,
  /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g,
  // Anthropic avant OpenAI : `sk-ant-` garde son préfixe complet
  /\b(sk-ant-)[A-Za-z0-9_-]{20,}/g,
  /\b(sk-(?:proj-)?)[A-Za-z0-9_-]{20,}/g,
  /\b([sr]k_(?:live|test)_)[A-Za-z0-9]{16,}/g,
  /\b(AIza)[0-9A-Za-z_-]{35}/g,
  /\b(npm_)[A-Za-z0-9]{36}\b/g,
  /\b(hf_)[A-Za-z0-9]{30,}\b/g,
  // JWT : en-tête et charge utile commencent par `{"` encodé
  /\b()eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

/**
 * Un identifiant d'URL est un secret s'il porte un mot de passe (`user:mdp`) ou s'il a la longueur d'un jeton ; un
 * simple nom (`git`, `deploy`) reste lisible.
 */
const secretUserinfo = (u: string) => u !== MASK && (u.includes(':') || u.length >= 20);

export function maskSecrets(text: string): string {
  let out = text.replace(PRIVATE_KEY, `clé privée ${MASK}`);
  out = out.replace(USERINFO, (all, scheme: string, user: string) =>
    secretUserinfo(user) ? `${scheme}${MASK}@` : all,
  );
  for (const re of TOKENS) out = out.replace(re, (_all, prefix: string) => `${prefix}${MASK}`);
  return out;
}

/** Vrai si le texte portait un secret : son masquage le change. */
export const hasSecret = (text: string): boolean => maskSecrets(text) !== text;

/** Masque chaque chaîne d'une valeur JSON (objets et tableaux en profondeur), sans toucher aux clés. */
export function maskDeep<T>(value: T): T {
  if (typeof value === 'string') return maskSecrets(value) as T;
  if (Array.isArray(value)) return value.map((v) => maskDeep(v)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = maskDeep(v);
    return out as T;
  }
  return value;
}
