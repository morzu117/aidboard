import type { MeshState } from '../../../src/shared/model.js';

// Chantier 25 (D99) : ce que la pastille et la section Mesh disent du monitor. Elles affichent ce qui est
// mesuré : `monitor status` prouve que le processus tourne, pas que les DM arrivent, d'où jamais « connecté ».

/** au-delà, l'état affiché n'est plus frais : la relecture tourne toutes les 30 s */
export const AGE_FRAIS_MS = 90_000;

export const dureeDepuis = (iso: string, now = Date.now()) => {
  const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (m < 1) return "moins d'une minute";
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h`;
  return `${Math.round(h / 24)} j`;
};

export function etatMonitor(s: MeshState, aTraiter: number, enCours: boolean, now = Date.now()) {
  if (enCours) return s.connected ? 'déconnexion du mesh…' : 'connexion au mesh…';
  if (s.monitor === 'proxy') return 'géré par le proxy';
  if (s.connected) return `monitor actif · ${aTraiter} à traiter`;
  if (s.monitor === 'stale') return 'monitor périmé';
  if (s.monitor === 'absent') return 'swarph introuvable';
  if (s.monitor === 'running') return 'monitor actif · Tailscale arrêté';
  return s.since ? `hors mesh depuis ${dureeDepuis(s.since, now)}` : 'monitor arrêté';
}

/** « lu il y a N min » quand la dernière lecture n'est plus fraîche ; rien hors connexion, où personne ne relit. */
export function ageLecture(s: MeshState, checkedAt: string | null, now = Date.now()) {
  if (!s.connected || !checkedAt) return null;
  return now - Date.parse(checkedAt) > AGE_FRAIS_MS
    ? `lu il y a ${dureeDepuis(checkedAt, now)}`
    : null;
}
