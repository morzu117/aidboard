import { Link, useLocation } from 'react-router';
import type { DaemonLink } from '../data/types.js';

const DAEMON_TEXT: Record<DaemonLink, string> = {
  connecte: 'daemon local',
  reconnexion: 'reconnexion au daemon…',
  injoignable: 'daemon injoignable',
  'session-expiree': 'session expirée',
};

export type EcranId = '1-1' | '1-2' | '1-3' | 'consignes' | 'reglages';

const LIENS = [
  { id: 'accueil', to: '/', label: 'Accueil' },
  { id: 'boite', to: '/boite', label: 'Boîte de réception' },
  { id: 'consignes', to: '/consignes', label: 'Consignes' },
  { id: 'reglages', to: '/reglages', label: 'Réglages' },
] as const;

export function Barre({
  screen,
  daemon,
  waiting,
  onNewTopic,
  onPalette,
}: {
  screen: EcranId;
  daemon: DaemonLink;
  /** agents qui attendent une réponse */
  waiting: number;
  onNewTopic: () => void;
  onPalette: () => void;
}) {
  const n = (rest: string) => `${screen}.barre.${rest}`;
  const { pathname } = useLocation();
  return (
    <header className="barre" data-node={`${screen}.barre`}>
      <span
        className="marque"
        data-node={n('marque')}
        style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35em' }}
      >
        <svg viewBox="0 0 520 490" aria-hidden="true" style={{ height: '1.1em', width: 'auto' }}>
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
        </svg>
        A-I-D
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
