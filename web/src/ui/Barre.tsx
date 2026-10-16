import { Link } from 'react-router';
import type { DaemonLink } from '../data/types.js';

const DAEMON_TEXT: Record<DaemonLink, string> = {
  connecte: 'daemon local',
  reconnexion: 'reconnexion au daemon…',
  injoignable: 'daemon injoignable',
  'session-expiree': 'session expirée',
};

export function Barre({
  screen,
  daemon,
  onNewTopic,
}: {
  screen: '1-1' | '1-3';
  daemon: DaemonLink;
  onNewTopic: () => void;
}) {
  const n = (rest: string) => `${screen}.barre.${rest}`;
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
        <Link
          className="nav-lien est-actif"
          data-node={n('nav-accueil')}
          data-action="nav.accueil"
          to="/"
          aria-current="page"
        >
          Accueil
        </Link>
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
