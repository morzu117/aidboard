import { execFile } from 'node:child_process';

export interface SujetSwairm {
  id: string;
  titre: string;
  etat: string;
  colonne: string;
  en_pause: boolean;
  pas: { total: number; par_etat: Record<string, number> };
  maj: string;
}
export interface VolSwairm {
  cible: string;
  machine: string;
  pid: number;
  depuis: string;
  tenant: string;
}
export interface StatutSwairm {
  projets: { projet: string; sujets: SujetSwairm[]; vols: VolSwairm[] }[];
  erreurs: { projet: string; board: string; erreur: string }[];
}
export type ResultatStatut =
  | { etat: 'ok'; data: StatutSwairm }
  | { etat: 'non-configure' }
  | { etat: 'erreur'; erreur: 'format' | 'timeout' | 'lecture' };

const objet = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const textes = (v: Record<string, unknown>, cles: string[]) =>
  cles.every((cle) => typeof v[cle] === 'string');
const compte = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** Le contrat reste extensible : les valeurs d'état et les champs inconnus sont ignorés. */
export function parseStatut(v: unknown): StatutSwairm | null {
  if (
    !objet(v) ||
    v.format !== 'swairm-status/1' ||
    !Array.isArray(v.projets) ||
    !Array.isArray(v.erreurs)
  )
    return null;
  const projets: StatutSwairm['projets'] = [];
  for (const p of v.projets) {
    if (
      !objet(p) ||
      typeof p.projet !== 'string' ||
      !Array.isArray(p.sujets) ||
      !Array.isArray(p.vols)
    )
      return null;
    const sujets: SujetSwairm[] = [];
    for (const s of p.sujets) {
      if (
        !objet(s) ||
        !textes(s, ['id', 'titre', 'etat', 'colonne', 'maj']) ||
        typeof s.en_pause !== 'boolean' ||
        !objet(s.pas) ||
        !compte(s.pas.total) ||
        !objet(s.pas.par_etat) ||
        !Object.values(s.pas.par_etat).every(compte)
      )
        return null;
      sujets.push({
        id: s.id as string,
        titre: s.titre as string,
        etat: s.etat as string,
        colonne: s.colonne as string,
        maj: s.maj as string,
        en_pause: s.en_pause,
        pas: { total: s.pas.total, par_etat: s.pas.par_etat as Record<string, number> },
      });
    }
    const vols: VolSwairm[] = [];
    for (const vol of p.vols) {
      if (!objet(vol) || !textes(vol, ['cible', 'machine', 'depuis', 'tenant']) || !compte(vol.pid))
        return null;
      vols.push({
        cible: vol.cible as string,
        machine: vol.machine as string,
        depuis: vol.depuis as string,
        tenant: vol.tenant as string,
        pid: vol.pid,
      });
    }
    projets.push({ projet: p.projet, sujets, vols });
  }
  const erreurs: StatutSwairm['erreurs'] = [];
  for (const e of v.erreurs) {
    if (!objet(e) || !textes(e, ['projet', 'board', 'erreur'])) return null;
    erreurs.push({
      projet: e.projet as string,
      board: e.board as string,
      erreur: e.erreur as string,
    });
  }
  return { projets, erreurs };
}

export class SwairmStatut {
  private cache?: { a: number; resultat: Promise<ResultatStatut> };
  constructor(
    private readonly bin?: string,
    private readonly options: { now?: () => number; delaiMs?: number } = {},
  ) {}

  lire(): Promise<ResultatStatut> {
    const now = this.options.now ?? Date.now;
    if (this.cache && (this.cache.a === -1 || now() - this.cache.a < 5000))
      return this.cache.resultat;
    const entree = { a: -1, resultat: this.executer() };
    this.cache = entree;
    void entree.resultat.then(() => {
      entree.a = now();
    });
    return entree.resultat;
  }

  private executer(): Promise<ResultatStatut> {
    if (!this.bin) return Promise.resolve({ etat: 'non-configure' });
    return new Promise((resolve) => {
      execFile(
        this.bin!,
        ['status', '--json'],
        { timeout: this.options.delaiMs ?? 10000, maxBuffer: 4 * 1024 * 1024 },
        (erreur, stdout) => {
          if (erreur) {
            resolve(
              erreur.code === 'ENOENT'
                ? { etat: 'non-configure' }
                : { etat: 'erreur', erreur: erreur.killed ? 'timeout' : 'lecture' },
            );
            return;
          }
          try {
            const data = parseStatut(JSON.parse(stdout) as unknown);
            resolve(data ? { etat: 'ok', data } : { etat: 'erreur', erreur: 'format' });
          } catch {
            resolve({ etat: 'erreur', erreur: 'format' });
          }
        },
      );
    });
  }
}
