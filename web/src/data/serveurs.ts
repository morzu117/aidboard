import { useEffect, useSyncExternalStore } from 'react';
import type { Server, ServerStatus, ServerTest } from '../../../src/shared/model.js';
import { AidApiError } from './api.js';
import type { AidClient } from './client.js';
import { useAidClient } from './useAidState.js';

/** Décision D.2 : refus d'une suppression dont le serveur n'a pas confirmé l'arrêt des agents ; « quand même » possible. */
export const arretNonConfirme = (err: unknown): boolean =>
  err instanceof AidApiError && err.status === 409 && typeof err.body.unconfirmed === 'number';

/** Relecture de la liste et des états : le daemon relance lui-même un contrôle au-delà de 60 s (S.3). */
export const SERVEURS_RELECTURE_MS = 30_000;

export interface ServeursEtat {
  /** null tant que la première lecture n'est pas revenue */
  servers: Server[] | null;
  statuses: Readonly<Record<string, ServerStatus>>;
  /** dernier test de connexion vu passer depuis l'ouverture de l'interface */
  tests: Readonly<Record<string, ServerTest>>;
  erreur: string | null;
}

export const statutInconnu = (serverId: string): ServerStatus => ({
  serverId,
  state: 'unknown',
  latencyMs: null,
  checkedAt: null,
  reason: null,
});

/**
 * Chantier 17 (S.4) : les serveurs ne sont pas dans `/api/state` (rien n'est un événement persisté). Un magasin
 * par client, partagé par l'écran Serveurs et la barre gauche : lecture au premier abonné, relecture périodique
 * tant qu'il en reste un (onglet visible, daemon joint), états tenus à jour par les `server.status` éphémères,
 * liste relue à la fin d'un test (agents détectés).
 *
 * Courses (review S.4) : une réponse ne remplace jamais un état reçu en éphémère pendant qu'elle était en vol,
 * ne ressuscite pas un serveur retiré entre-temps, et une demande de relecture pendant une lecture en relance une.
 */
export class ServeursStore {
  private etat: ServeursEtat = { servers: null, statuses: {}, tests: {}, erreur: null };
  private abonnes = new Set<() => void>();
  private minuteur: ReturnType<typeof setInterval> | null = null;
  private lecture: Promise<void> | null = null;
  private encore = false;
  /** serveurs dont l'état est arrivé en direct pendant la lecture en vol */
  private touches = new Set<string>();
  private retires = new Set<string>();
  private vus: ReturnType<AidClient['getSnapshot']> | null = null;
  private desabonnerClient: (() => void) | null = null;

  constructor(private readonly client: AidClient) {}

  subscribe = (cb: () => void): (() => void) => {
    this.abonnes.add(cb);
    if (this.abonnes.size === 1) this.demarrer();
    return () => {
      this.abonnes.delete(cb);
      if (this.abonnes.size === 0) this.arreter();
    };
  };

  getSnapshot = (): ServeursEtat => this.etat;

  /** Relit la liste et les états. Pendant une lecture, la demande est notée et relancée à sa fin. */
  recharger(): Promise<void> {
    if (this.lecture) {
      this.encore = true;
      return this.lecture;
    }
    this.touches.clear();
    this.lecture = Promise.all([
      this.client.request<Server[]>('GET', '/api/servers'),
      // un état illisible ne cache pas la liste : les serveurs restent, en « non contrôlé »
      this.client.request<ServerStatus[]>('GET', '/api/servers/status').catch(() => []),
    ])
      .then(([servers, statuses]) => {
        const liste = (Array.isArray(servers) ? servers : []).filter(
          (s) => !this.retires.has(s.id),
        );
        const parId: Record<string, ServerStatus> = {};
        for (const s of Array.isArray(statuses) ? statuses : []) parId[s.serverId] = s;
        for (const id of this.touches) {
          const direct = this.etat.statuses[id];
          if (direct) parId[id] = direct;
        }
        this.publier({ servers: liste, statuses: parId, erreur: null });
      })
      .catch((err: unknown) =>
        this.publier({ erreur: err instanceof Error ? err.message : String(err) }),
      )
      .finally(() => {
        this.lecture = null;
        if (this.encore) {
          this.encore = false;
          void this.recharger();
        }
      });
    return this.lecture;
  }

  /** Un état connu autrement que par éphémère (réponse d'un ping) : appliqué comme s'il était arrivé en direct. */
  appliquer(status: ServerStatus): void {
    this.touches.add(status.serverId);
    this.publier({ statuses: { ...this.etat.statuses, [status.serverId]: status } });
  }

  /** Après une suppression : le serveur disparaît tout de suite, et une relecture partie avant ne le ramène pas. */
  retirer(serverId: string): void {
    this.retires.add(serverId);
    const statuses = { ...this.etat.statuses };
    delete statuses[serverId];
    this.publier({
      servers: this.etat.servers?.filter((s) => s.id !== serverId) ?? null,
      statuses,
    });
  }

  private demarrer(): void {
    void this.recharger();
    this.minuteur = setInterval(() => {
      // onglet caché ou daemon perdu : aucun contrôle ssh entretenu pour rien (review S.4)
      if (typeof document !== 'undefined' && document.hidden) return;
      if (this.client.getSnapshot().daemon !== 'connecte') return;
      void this.recharger();
    }, SERVEURS_RELECTURE_MS);
    this.vus = this.client.getSnapshot();
    this.desabonnerClient = this.client.subscribe(() => this.suivre());
  }

  private arreter(): void {
    if (this.minuteur) clearInterval(this.minuteur);
    this.minuteur = null;
    this.desabonnerClient?.();
    this.desabonnerClient = null;
  }

  /** Les messages éphémères reçus depuis le dernier passage : seuls les objets nouveaux sont repris. */
  private suivre(): void {
    const snap = this.client.getSnapshot();
    const avant = this.vus;
    this.vus = snap;
    const statuses: Record<string, ServerStatus> = {};
    for (const [id, s] of Object.entries(snap.serverStatuses ?? {}))
      if (avant?.serverStatuses?.[id] !== s && !this.retires.has(id)) statuses[id] = s;
    const tests: Record<string, ServerTest> = {};
    for (const [id, t] of Object.entries(snap.serverTests ?? {}))
      if (avant?.serverTests?.[id] !== t && !this.retires.has(id)) tests[id] = t;
    if (Object.keys(statuses).length === 0 && Object.keys(tests).length === 0) return;
    for (const id of Object.keys(statuses)) this.touches.add(id);
    this.publier({
      statuses: { ...this.etat.statuses, ...statuses },
      tests: { ...this.etat.tests, ...tests },
    });
    if (Object.values(tests).some((t) => t.finishedAt)) void this.recharger();
  }

  private publier(patch: Partial<ServeursEtat>): void {
    this.etat = { ...this.etat, ...patch };
    for (const cb of this.abonnes) cb();
  }
}

const magasins = new WeakMap<AidClient, ServeursStore>();

export function serveursStore(client: AidClient): ServeursStore {
  let s = magasins.get(client);
  if (!s) {
    s = new ServeursStore(client);
    magasins.set(client, s);
  }
  return s;
}

export function useServeurs(): ServeursEtat & { store: ServeursStore } {
  const store = serveursStore(useAidClient());
  const etat = useSyncExternalStore(store.subscribe, store.getSnapshot);
  // un écran monté après la première lecture garde le cache et relit quand même (liste fraîche à l'ouverture)
  useEffect(() => {
    if (store.getSnapshot().servers !== null) void store.recharger();
  }, [store]);
  return { ...etat, store };
}
