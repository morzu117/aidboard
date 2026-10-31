import type { GitCommitDetail, ServerGitLog, ServerGitStatus } from '../../../src/shared/git.js';
import type { ServerFilePreview, ServerFsListing } from '../../../src/shared/model.js';
import type { AgentStreamItem } from '../../../src/shared/conversation.js';
import type { AidClient } from './client.js';

/** Chantier 17 (F.3) : ce que l'écran Discussion lit et écrit pour le panneau Fichiers / Git d'un serveur. */
export type OngletPanneau = 'files' | 'git';
export interface PanneauPref {
  open: boolean;
  tab: OngletPanneau;
}
export type PorteeGit = 'all' | 'branch';
export type EcritureGit = 'fetch' | 'push' | 'sync';

type Client = Pick<AidClient, 'request'>;
const q = (path: string) => `path=${encodeURIComponent(path)}`;

export const lirePanneau = (c: Client, serverId: string) =>
  c.request<PanneauPref>('GET', `/api/servers/${serverId}/panel`);

export const ecrirePanneau = (c: Client, serverId: string, pref: PanneauPref) =>
  c.request<PanneauPref>('PUT', `/api/servers/${serverId}/panel`, pref);

export const lireDossier = (c: Client, serverId: string, path: string) =>
  c.request<ServerFsListing>('GET', `/api/servers/${serverId}/fs?${q(path)}`);

export const lireFichier = (c: Client, serverId: string, path: string) =>
  c.request<ServerFilePreview>('GET', `/api/servers/${serverId}/file?${q(path)}`);

export const lireEtatGit = (c: Client, serverId: string, path: string) =>
  c.request<ServerGitStatus>('GET', `/api/servers/${serverId}/git/status?${q(path)}`);

export const lireJournalGit = (c: Client, serverId: string, path: string, scope: PorteeGit) =>
  c.request<ServerGitLog>('GET', `/api/servers/${serverId}/git/log?${q(path)}&scope=${scope}`);

export const lireCommit = (c: Client, serverId: string, path: string, hash: string) =>
  c.request<GitCommitDetail>(
    'GET',
    `/api/servers/${serverId}/git/commits/${encodeURIComponent(hash)}?${q(path)}`,
  );

/** Pousser et Synchroniser : la confirmation porte le commit affiché (`head`), refus du daemon sinon. */
export const ecrireGit = (
  c: Client,
  serverId: string,
  op: EcritureGit,
  body: { path: string; confirm?: boolean; head?: string },
) => c.request<ServerGitStatus>('POST', `/api/servers/${serverId}/git/${op}`, body);

/** Chemin d'une entrée sous un dossier tel que demandé (`~/proj` + `src` → `~/proj/src`). */
export const sousChemin = (dossier: string, nom: string) =>
  dossier.endsWith('/') ? `${dossier}${nom}` : `${dossier}/${nom}`;

/** Âge des données de la barre du panneau (§11.3.1 : « il y a N s »). */
export function age(readAt: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(readAt)) / 1000));
  if (s < 60) return `il y a ${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `il y a ${m} min`;
  return `il y a ${Math.round(m / 60)} h`;
}

/**
 * F.4 (§11.3.1) : fin d'un groupe d'outils de l'agent — après au moins un outil terminé, il passe à autre chose
 * (message, fin de tour, demande, sortie). Le lien rétabli compte aussi : ce qu'il a fait pendant la coupure n'a pas
 * été vu. Un événement déjà vu (même `seq`, redélivré) ne compte pas deux fois.
 */
export interface SuiviOutils {
  /** Nombre de fins de groupe vues : le panneau se relit quand il change. */
  fins: number;
  outilTermine: boolean;
  seq: number;
}

const APRES_OUTILS = new Set(['message', 'turn_end', 'request', 'exit']);

export function suivreOutils(
  s: SuiviOutils,
  it: Pick<AgentStreamItem, 'seq' | 'event'>,
): SuiviOutils {
  if (it.seq <= s.seq) return s;
  const e = it.event;
  if (e.type === 'tool_end') return { ...s, outilTermine: true, seq: it.seq };
  if (e.type === 'connection_resumed')
    return { fins: s.fins + 1, outilTermine: false, seq: it.seq };
  if (s.outilTermine && APRES_OUTILS.has(e.type))
    return { fins: s.fins + 1, outilTermine: false, seq: it.seq };
  // rien ne change pour le panneau : même objet, pas de rendu (le `seq` suivant reste comparé au dernier compté)
  return s;
}
