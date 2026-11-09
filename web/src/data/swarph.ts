import { useEffect, useSyncExternalStore } from 'react';
import type { BoardResult } from '../../../src/shared/board.js';
import type { MeshState } from '../../../src/shared/model.js';
import {
  requeteCodegraphValide,
  tagValide,
  typeValide,
  slugValide,
} from '../../../src/shared/swarph.js';
import type {
  PairSwarph,
  DroitsSwarph,
  LigneCodegraph,
  ResumeMemoire,
  PageMemoire,
  LienMemoire,
} from '../../../src/shared/swarph.js';
import { BOARD_RELECTURE_MS, type BoardLecture } from './board.js';
import type { AidClient } from './client.js';
import { useAidClient } from './useAidState.js';

const reussiParDefaut = (r: unknown): boolean => {
  const resultat = r as {
    ok?: boolean;
    peers?: { ok: boolean };
    rights?: { ok: boolean };
    page?: { ok: boolean };
  };
  return (
    resultat.ok === true ||
    resultat.peers?.ok === true ||
    resultat.rights?.ok === true ||
    resultat.page?.ok === true
  );
};

export class SwarphStore<T> {
  private etat: BoardLecture<T> = { result: null, enLecture: false, luA: null, erreur: null };
  private abonnes = new Set<() => void>();
  private minuteur: ReturnType<typeof setInterval> | null = null;
  private desabonnerClient: (() => void) | null = null;
  private joint = false;
  private envoyees = 0;
  private appliquee = 0;
  private enVol = 0;

  constructor(
    private readonly client: AidClient,
    private readonly path: string,
    private readonly lu: (t: T) => string | null,
  ) {}

  subscribe = (cb: () => void): (() => void) => {
    this.abonnes.add(cb);
    if (this.abonnes.size === 1) this.demarrer();
    return () => {
      this.abonnes.delete(cb);
      if (this.abonnes.size === 0) this.arreter();
    };
  };

  getSnapshot = (): BoardLecture<T> => this.etat;

  /** `fresh` : le bouton Relire, qui contourne le cache du daemon. */
  lire(fresh = false): Promise<void> {
    const n = ++this.envoyees;
    this.enVol++;
    this.publier({ enLecture: true });
    return this.client
      .request<T>(
        'GET',
        fresh ? `${this.path}${this.path.includes('?') ? '&' : '?'}fresh=1` : this.path,
      )
      .then((result) => {
        if (n < this.appliquee) return;
        this.appliquee = n;
        this.publier({ result, luA: this.lu(result), erreur: null });
        if (reussiParDefaut(result)) this.publier({ reussieA: this.etat.luA });
      })
      .catch((err: unknown) => {
        if (n < this.appliquee) return;
        this.appliquee = n;
        this.publier({ erreur: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => {
        this.enVol--;
        if (this.enVol === 0) this.publier({ enLecture: false });
      });
  }

  relire = (): Promise<void> => this.lire(true);

  private peutLire(): boolean {
    if (typeof document !== 'undefined' && document.hidden) return false;
    return this.client.getSnapshot().daemon === 'connecte';
  }

  private auFocus = () => {
    if (this.peutLire()) void this.lire();
  };

  private demarrer(): void {
    this.joint = this.client.getSnapshot().daemon === 'connecte';
    if (this.peutLire()) void this.lire();
    this.minuteur = setInterval(() => {
      if (this.peutLire()) void this.lire();
    }, BOARD_RELECTURE_MS);
    if (typeof window !== 'undefined') window.addEventListener('focus', this.auFocus);
    // daemon retrouvé : une lecture, comme à l'ouverture
    this.desabonnerClient = this.client.subscribe(() => {
      const joint = this.client.getSnapshot().daemon === 'connecte';
      if (joint && !this.joint && this.peutLire()) void this.lire();
      this.joint = joint;
    });
  }

  private arreter(): void {
    if (this.minuteur) clearInterval(this.minuteur);
    this.minuteur = null;
    if (typeof window !== 'undefined') window.removeEventListener('focus', this.auFocus);
    this.desabonnerClient?.();
    this.desabonnerClient = null;
  }

  private publier(patch: Partial<BoardLecture<T>>): void {
    this.etat = { ...this.etat, ...patch };
    for (const cb of this.abonnes) cb();
  }
}

const magasins = new WeakMap<AidClient, Map<string, SwarphStore<unknown>>>();
const vide: BoardLecture<never> = { result: null, enLecture: false, luA: null, erreur: null };
const abonnerVide = () => () => {};
const lireVide = () => Promise.resolve();

function useLecture<T>(path: string | null, lu: (r: T) => string | null) {
  const client = useAidClient();
  let chemins = magasins.get(client);
  if (!chemins) {
    chemins = new Map();
    magasins.set(client, chemins);
  }
  let magasin = path === null ? undefined : (chemins.get(path) as SwarphStore<T> | undefined);
  if (path !== null && !magasin) {
    magasin = new SwarphStore(client, path, lu);
    chemins.set(path, magasin as SwarphStore<unknown>);
  }
  const etat = useSyncExternalStore(
    magasin?.subscribe ?? abonnerVide,
    magasin?.getSnapshot ?? (() => vide),
  );
  useEffect(() => {
    if (magasin && magasin.getSnapshot().result !== null) void magasin.lire();
  }, [magasin]);
  return { ...etat, relire: magasin?.relire ?? lireVide };
}

export interface LectureCells {
  peers: BoardResult<PairSwarph[]>;
  monitor: MeshState;
}
export interface LectureReglages {
  rights: BoardResult<DroitsSwarph>;
  monitor: MeshState;
}
export interface LecturePageMemoire {
  page: BoardResult<PageMemoire>;
  links: BoardResult<LienMemoire[]>;
}
const luResultat = <T>(r: BoardResult<T>) => r.readAt;
export const useCells = () => useLecture<LectureCells>('/api/swarph/cells', (r) => r.peers.readAt);
export const useReglages = () =>
  useLecture<LectureReglages>('/api/swarph/reglages', (r) => r.rights.readAt);
export const useFederation = (q: string) =>
  useLecture<BoardResult<{ lignes: LigneCodegraph[]; perime: boolean }>>(
    requeteCodegraphValide(q) ? `/api/swarph/federation?q=${encodeURIComponent(q)}` : null,
    luResultat,
  );
export const useMemoire = (tag: string | null, type = '') =>
  useLecture<BoardResult<ResumeMemoire[]>>(
    tag === null || (tag && !tagValide(tag)) || (type && !typeValide(type)) || (tag && type)
      ? null
      : `/api/swarph/memory${tag ? `?tag=${encodeURIComponent(tag)}` : type ? `?type=${encodeURIComponent(type)}` : ''}`,
    luResultat,
  );
export const usePageMemoire = (slug: string) =>
  useLecture<LecturePageMemoire>(
    slugValide(slug) ? `/api/swarph/memory/page?slug=${encodeURIComponent(slug)}` : null,
    (r) => r.page.readAt,
  );
