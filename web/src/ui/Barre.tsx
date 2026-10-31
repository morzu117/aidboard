import { Link, useLocation } from 'react-router';
import type { MeshState } from '../../../src/shared/model.js';
import type { DaemonLink } from '../data/types.js';

const DAEMON_TEXT: Record<DaemonLink, string> = {
  connecte: 'daemon local',
  reconnexion: 'reconnexion au daemon…',
  injoignable: 'daemon injoignable',
  'session-expiree': 'session expirée',
};

export type EcranId = '1-1' | '1-2' | '1-3' | 'consignes' | 'reglages' | 'serveurs';

/** La pastille « Mesh » de la barre (12.5) : absente quand `mesh.cell` n'est pas configuré. */
export interface BarreMesh {
  state: MeshState;
  /** DM `question`/`unblock` pas encore vus */
  aTraiter: number;
  tailscaleManage: boolean;
  /** un connect/disconnect est parti et son résultat n'est pas encore arrivé par `mesh.state` */
  enCours: boolean;
  onToggle: () => void;
}

const dureeDepuis = (iso: string, now = Date.now()) => {
  const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (m < 1) return "moins d'une minute";
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h`;
  return `${Math.round(h / 24)} j`;
};

/** Pourquoi « rejoindre » est impossible, ou null. Tailscale ne se monte que si `mesh.tailscale.manage` (D37). */
export function meshBloque(m: BarreMesh): string | null {
  if (m.state.connected || m.enCours) return null;
  if (m.state.tailscale === 'absent')
    return 'Tailscale introuvable : impossible de rejoindre le mesh';
  if (m.state.tailscale === 'stopped' && !m.tailscaleManage)
    return 'Tailscale est arrêté : le démarrer d’abord (ou mesh.tailscale.manage: true dans config.yaml)';
  return null;
}

export function meshTexte(m: BarreMesh, now = Date.now()): string {
  const s = m.state;
  if (m.enCours) return s.connected ? 'mesh · déconnexion…' : 'mesh · connexion…';
  if (s.connected) return `mesh · ${m.aTraiter} à traiter`;
  return s.since ? `hors mesh depuis ${dureeDepuis(s.since, now)}` : 'hors mesh';
}

const LIENS = [
  { id: 'accueil', to: '/', label: 'Accueil' },
  { id: 'boite', to: '/boite', label: 'Boîte de réception' },
  { id: 'consignes', to: '/consignes', label: 'Consignes' },
  // chantier 17 (S.4) : la maquette Servers place « Serveurs » entre Consignes et Réglages (§5.1)
  { id: 'serveurs', to: '/serveurs', label: 'Serveurs' },
  { id: 'reglages', to: '/reglages', label: 'Réglages' },
] as const;

export function Barre({
  screen,
  daemon,
  waiting,
  onNewTopic,
  onPalette,
  mesh,
}: {
  screen: EcranId;
  daemon: DaemonLink;
  /** agents qui attendent une réponse */
  waiting: number;
  onNewTopic: () => void;
  onPalette: () => void;
  mesh?: BarreMesh | null;
}) {
  const n = (rest: string) => `${screen}.barre.${rest}`;
  const { pathname } = useLocation();
  return (
    <header className="barre" data-node={`${screen}.barre`}>
      <span
        className="marque"
        data-node={n('marque')}
        style={{ display: 'inline-flex', alignItems: 'center' }}
      >
        <svg
          viewBox="0 0 1660 490"
          aria-hidden="true"
          role="img"
          aria-label="A-I-D"
          style={{ height: '1.1em', width: 'auto' }}
        >
          <path
            d="M70 70 245 225 70 380"
            stroke="#FFFFFF"
            strokeWidth="140"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
            transform="translate(20 20)"
          />
          <circle cx="430" cy="96" r="70" fill="#00D994" />
          <circle cx="430" cy="245" r="70" fill="#FFFFFF" />
          <circle cx="430" cy="395" r="70" fill="#FFFFFF" />
          <g transform="translate(545 27)" fill="#FFFFFF">
            <path
              fillRule="evenodd"
              d="M3 356 163 42Q180 0 227 0 274 0 294 44L456 356Q480 414 427 436 377 457 350 400L322 346H132L107 401Q82 455 32 436-18 418 3 356ZM177 258H282L230 130Z"
            />
            <rect x="480" width="118" height="438" rx="59" />
            <path
              fillRule="evenodd"
              d="M695 0H848C1000 0 1092 82 1092 219S1000 438 848 438H695Q648 438 648 391V47Q648 0 695 0ZM766 103V335H843C928 335 974 296 974 219S928 103 843 103Z"
            />
          </g>
        </svg>
      </span>
      <nav className="nav" data-node={n('nav')} aria-label="Navigation principale">
        {LIENS.map((l) => {
          const actif = pathname === l.to;
          return (
            <Link
              key={l.id}
              className={`nav-lien${actif ? ' est-actif' : ''}`}
              data-node={n(`nav-${l.id}`)}
              data-action={`nav.${l.id}`}
              to={l.to}
              aria-current={actif ? 'page' : undefined}
            >
              {l.label}
              {l.id === 'boite' && waiting > 0 && (
                <span
                  className="compteur"
                  data-node={n('nav-boite.compte')}
                  data-bind="resume.en_attente"
                >
                  {waiting}
                </span>
              )}
            </Link>
          );
        })}
      </nav>
      <div className="barre-droite">
        {mesh && (
          <button
            className="bouton-mesh"
            data-node={n('mesh')}
            data-action={mesh.state.connected ? 'mesh.deconnecter' : 'mesh.connecter'}
            type="button"
            disabled={mesh.enCours || meshBloque(mesh) !== null}
            title={
              meshBloque(mesh) ??
              (mesh.state.connected
                ? `Quitter le mesh (cell ${mesh.state.cell})`
                : `Rejoindre le mesh (cell ${mesh.state.cell})`)
            }
            onClick={mesh.onToggle}
          >
            <span
              className={`point point--${mesh.state.connected ? 'ok' : mesh.enCours ? 'attente' : 'inactif'}`}
              aria-hidden="true"
            />
            <span data-node={n('mesh.texte')} data-bind="mesh.etat">
              {meshTexte(mesh)}
            </span>
          </button>
        )}
        <span className="etat-daemon" data-node={n('daemon')}>
          <span
            className={`point point--${daemon === 'connecte' ? 'ok' : 'erreur'}`}
            aria-hidden="true"
          />
          <span data-node={n('daemon.texte')} data-bind="daemon.etat">
            {DAEMON_TEXT[daemon]}
          </span>
        </span>
        <button
          className="bouton-recherche"
          data-node={n('recherche')}
          data-action="palette.ouvrir"
          type="button"
          aria-label="Rechercher ou lancer une action"
          onClick={onPalette}
        >
          <svg className="icone" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <circle cx="11" cy="11" r="6" />
            <path d="M20 20l-4.5-4.5" />
          </svg>
          <span className="recherche-libelle">Rechercher ou lancer une action</span>
          <kbd className="raccourci">⌘K</kbd>
        </button>
        <button
          className="bouton bouton--primaire"
          data-node={n('nouveau-sujet')}
          data-action="sujet.creer"
          type="button"
          onClick={onNewTopic}
        >
          Nouveau sujet
        </button>
      </div>
    </header>
  );
}
