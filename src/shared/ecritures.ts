export const KINDS_ECRITURE = ['status', 'question', 'answer', 'unblock', 'fyi'] as const;
export type KindEcriture = (typeof KINDS_ECRITURE)[number];
interface MessageEcriture {
  kind: KindEcriture;
  texte: string;
}
export interface ParametresEcriture {
  'carte.note': MessageEcriture & { carte: number; a: string | null };
  'dm.envoyer': MessageEcriture & { pair: string; fil: string | null };
  'canal.poster': MessageEcriture & { canal: string };
}
export type ActionEcriture = keyof ParametresEcriture;
type Ecriture = {
  [A in ActionEcriture]: { action: A; params: ParametresEcriture[A] };
}[ActionEcriture];
const nom = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/.exec(v)?.[0] === v;
const entier = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const uuid = (v: unknown): boolean =>
  typeof v === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.exec(v)?.[0] === v;
export function lireParamsEcriture<A extends ActionEcriture>(
  action: A,
  brut: unknown,
  cell: string,
): { ok: true; params: ParametresEcriture[A] } | { ok: false; message: string } {
  const refus = { ok: false as const, message: 'Paramètres d’écriture invalides' };
  if (!brut || typeof brut !== 'object' || Array.isArray(brut)) return refus;
  const p = brut as Record<string, unknown>;
  const commun = {
    kind: (v: unknown) => KINDS_ECRITURE.includes(v as KindEcriture),
    texte: (v: unknown) =>
      typeof v === 'string' &&
      v.trim().length > 0 &&
      Array.from(v).length <= 4000 &&
      !/\p{Cc}/u.test(v.replace(/[\n\t]/g, '')),
  };
  const schemas: Record<ActionEcriture, Record<string, (v: unknown) => boolean>> = {
    'carte.note': { ...commun, carte: entier, a: (v) => v === null || nom(v) },
    'dm.envoyer': {
      ...commun,
      pair: (v) => nom(v) && v !== cell,
      fil: (v) => v === null || uuid(v),
    },
    'canal.poster': { ...commun, canal: nom },
  };
  if (!Object.hasOwn(schemas, action)) return refus;
  const schema = schemas[action];
  if (
    Reflect.ownKeys(p).length !== Object.keys(schema).length ||
    !Object.entries(schema).every(([k, valider]) => Object.hasOwn(p, k) && valider(p[k]))
  )
    return refus;
  return { ok: true, params: { ...p } as unknown as ParametresEcriture[A] };
}
export function argvEcriture<A extends ActionEcriture>(
  action: A,
  params: ParametresEcriture[A],
  cell: string,
): string[] {
  if (!nom(cell) || !lireParamsEcriture(action, params, cell).ok)
    throw new Error('Paramètres d’écriture invalides');
  const p = { action, params } as Ecriture;
  switch (p.action) {
    case 'carte.note':
      return [
        'board',
        'cards',
        'say',
        String(p.params.carte),
        '--content-file',
        'FICHIER',
        '--kind',
        p.params.kind,
        ...(p.params.a ? ['--to', p.params.a] : []),
        '--as',
        cell,
      ];
    case 'dm.envoyer':
      return [
        'mesh',
        'send',
        p.params.pair,
        '--kind',
        p.params.kind,
        '--content-file',
        'FICHIER',
        ...(p.params.fil ? ['--thread', p.params.fil] : []),
        '--as',
        cell,
      ];
    case 'canal.poster':
      return [
        'channel',
        'post',
        p.params.canal,
        '--kind',
        p.params.kind,
        '--content-file',
        'FICHIER',
        '--as',
        cell,
      ];
  }
}
export function resumeEcriture<A extends ActionEcriture>(
  action: A,
  params: ParametresEcriture[A],
): string {
  if (!lireParamsEcriture(action, params, '').ok)
    throw new Error('Paramètres d’écriture invalides');
  const p = { action, params } as Ecriture;
  switch (p.action) {
    case 'carte.note':
      return `Note ${p.params.kind} sur la carte #${p.params.carte}${p.params.a ? `, à ${p.params.a}` : ''}`;
    case 'dm.envoyer':
      return `DM ${p.params.kind} à ${p.params.pair}${p.params.fil ? ', dans un fil' : ''}`;
    case 'canal.poster':
      return `Post ${p.params.kind} sur le canal ${p.params.canal}`;
  }
}
export function lireReponseEcriture(
  brut: unknown,
):
  | { ok: true; id: number; open_obligations: number[]; closed_obligations: number[] }
  | { ok: false; kind: 'format' }
  | { ok: false; kind: 'obligation-close'; ids: number[] } {
  if (!brut || typeof brut !== 'object' || Array.isArray(brut))
    return { ok: false, kind: 'format' };
  const p = brut as Record<string, unknown>;
  if (!Array.isArray(p.closed_obligations) || !p.closed_obligations.every(entier))
    return { ok: false, kind: 'format' };
  if (p.closed_obligations.length)
    return { ok: false, kind: 'obligation-close', ids: [...p.closed_obligations] };
  if (!entier(p.id) || !Array.isArray(p.open_obligations) || !p.open_obligations.every(entier))
    return { ok: false, kind: 'format' };
  return { ok: true, id: p.id, open_obligations: [...p.open_obligations], closed_obligations: [] };
}
