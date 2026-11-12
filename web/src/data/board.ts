import { cheminMesh, useMeshLecture } from './meshLecture.js';
import { useEffect, useSyncExternalStore } from 'react';
import type {
  BoardCardSheet,
  BoardCardSummary,
  BoardProject,
  BoardResult,
} from '../../../src/shared/board.js';
import type { AidClient } from './client.js';
import { useAidClient } from './useAidState.js';

/** Chantier 24 (D97) : relecture du board tant que l'écran est ouvert ; le daemon garde 5 s de cache (D94). */
export const BOARD_RELECTURE_MS = 60_000;

export interface BoardLecture<T> {
  /** null tant que la première lecture n'est pas revenue ; les erreurs de swarph sont dedans (D95) */
  result: T | null;
  enLecture: boolean;
  /** `readAt` du résultat affiché, pour « Board lu il y a N s » */
  luA: string | null;
  /** échec de la requête elle-même (mesh désactivé, daemon perdu), pas une erreur de swarph */
  erreur: string | null;
  /** Chantier 25 (D110) : `readAt` de la dernière lecture réussie, pour le bandeau « Board indisponible » */
  reussieA?: string | null;
}

/** Un résultat de swarph qui a abouti ; la fiche d'une carte réussit quand sa carte a été lue. */
const reussiParDefaut = (t: unknown): boolean => {
  const r = t as { ok?: unknown; card?: { ok?: unknown } } | null;
  return r?.ok === true || r?.card?.ok === true;
};

/**
 * Une lecture du board, un magasin par chemin et par client, sur le modèle de `ServeursStore` : lecture au
 * premier abonné, au retour du focus et toutes les 60 s, seulement onglet visible et daemon joint. Rien n'est
 * gardé ailleurs qu'en mémoire. Chaque lecture porte un numéro : une réponse en retard n'écrase jamais celle
 * d'une lecture partie après elle.
 */
export class BoardStore<T> {
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
        noterLu(this.client, this.etat.luA);
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

/**
 * D101 : la dernière lecture du board, tous chemins confondus, pour « board lu il y a N s » dans la barre du
 * haut. Nourrie par les magasins, elle ne lit jamais rien elle-même.
 */
const derniersLus = new WeakMap<AidClient, { luA: string | null; abonnes: Set<() => void> }>();

function dernierLu(client: AidClient) {
  let d = derniersLus.get(client);
  if (!d) {
    d = { luA: null, abonnes: new Set() };
    derniersLus.set(client, d);
  }
  return d;
}

function noterLu(client: AidClient, luA: string | null): void {
  const d = dernierLu(client);
  if (!luA || (d.luA !== null && Date.parse(d.luA) >= Date.parse(luA))) return;
  d.luA = luA;
  for (const cb of d.abonnes) cb();
}

export function useBoardLuA(): string | null {
  const d = dernierLu(useAidClient());
  return useSyncExternalStore(
    (cb) => {
      d.abonnes.add(cb);
      return () => void d.abonnes.delete(cb);
    },
    () => d.luA,
  );
}

const magasins = new WeakMap<AidClient, Map<string, BoardStore<unknown>>>();

export function boardStore<T>(
  client: AidClient,
  path: string,
  lu: (t: T) => string | null,
): BoardStore<T> {
  let parChemin = magasins.get(client);
  if (!parChemin) {
    parChemin = new Map();
    magasins.set(client, parChemin);
  }
  let s = parChemin.get(path) as BoardStore<T> | undefined;
  if (!s) {
    s = new BoardStore<T>(client, path, lu);
    parChemin.set(path, s as BoardStore<unknown>);
  }
  return s;
}

function useBoardLecture<T>(
  path: string,
  lu: (t: T) => string | null,
  nom?: string,
): BoardLecture<T> & { mesh: string; relire: () => Promise<void> } {
  const courant = useMeshLecture();
  const mesh = nom ?? courant;
  const store = boardStore(useAidClient(), cheminMesh(path, mesh), lu);
  const etat = useSyncExternalStore(store.subscribe, store.getSnapshot);
  // un écran remonté garde le résultat précédent et relit quand même
  useEffect(() => {
    if (store.getSnapshot().result !== null) void store.lire();
  }, [store]);
  return { ...etat, mesh, relire: store.relire };
}

const luResultat = <D>(r: BoardResult<D>) => r?.readAt ?? null;

export const useBoardProjects = (mesh?: string) =>
  useBoardLecture<BoardResult<BoardProject[]>>('/api/board/projects', luResultat, mesh);

export const useBoardCards = (projectId: number, mesh?: string) =>
  useBoardLecture<BoardResult<BoardCardSummary[]>>(
    `/api/board/projects/${projectId}/cards`,
    luResultat,
    mesh,
  );

export function useBoardCard(cardId: number, mesh?: string) {
  const lecture = useBoardLecture<BoardCardSheet>(
    `/api/board/cards/${cardId}`,
    (s) => s?.card?.readAt ?? null,
    mesh,
  );
  return { ...lecture, result: lecture.result ? { ...lecture.result, mesh: lecture.mesh } : null };
}

/** Un nom réactivé après archivage désigne une nouvelle identité : aucun résultat ne se réutilise. */
export function oublierLecturesBoard(client: AidClient): void {
  const chemins = magasins.get(client);
  for (const chemin of chemins?.keys() ?? []) {
    if (chemin !== '/api/meshes') chemins?.delete(chemin);
  }
}
