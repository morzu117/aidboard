import { useState } from 'react';
import { Link, useLocation } from 'react-router';
import type { Server, ServerStatus, ServerTest } from '../../../src/shared/model.js';
import { statutInconnu, useServeurs } from '../data/serveurs.js';
import { useAid } from '../data/useAidState.js';
import { depuis } from './depuis.js';
import { IconeServeur } from './Serveur.js';

// Chantier 25 (D106) : le bloc VPS de la barre par état, une carte par serveur. Elle dit si le serveur répond,
// si A-I-D suit encore ses agents, et ce qu'il y a à faire quand ce n'est plus le cas.

export type EtatVps =
  'connecte' | 'reconnexion' | 'suivi-coupe' | 'session-perdue' | 'injoignable' | 'inconnu';

const LIBELLE: Record<EtatVps, string> = {
  connecte: 'Connecté',
  reconnexion: 'Reconnexion…',
  'suivi-coupe': 'Suivi coupé',
  'session-perdue': 'Session perdue',
  injoignable: 'Injoignable',
  inconnu: 'Non contrôlé',
};

/** Le serveur d'abord (un serveur muet coupe tous ses suivis), puis le pire de ses agents. */
export function etatVps(status: ServerStatus): EtatVps {
  if (status.state === 'connecting') return 'reconnexion';
  if (status.state === 'unreachable' || status.state === 'error') return 'injoignable';
  if (status.agents?.repriseEchouee) return 'session-perdue';
  if (status.agents?.suiviCoupe) return 'suivi-coupe';
  return status.state === 'connected' ? 'connecte' : 'inconnu';
}

/** Ce qui a lâché au dernier test, sinon la raison de l'état mesuré. */
function etapeEchouee(test: ServerTest | undefined, status: ServerStatus): string | null {
  const etape = test?.finishedAt ? test.steps.find((s) => s.state === 'failed') : undefined;
  if (etape) return `${etape.label} : ${etape.detail ?? test?.error ?? 'échec'}`;
  return status.reason;
}

function Carte({
  n,
  s,
  status,
  test,
}: {
  n: (rest: string) => string;
  s: Server;
  status: ServerStatus;
  test?: ServerTest;
}) {
  const { call } = useAid();
  const { pathname } = useLocation();
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const etat = etatVps(status);
  const id = n(`vps.serveur-${s.id}`);
  const discussion = status.agents?.discussion
    ? `/serveurs/${s.id}/discussions/${status.agents.discussion}`
    : `/serveurs/${s.id}/discussion`;
  const diagnostiquer = async () => {
    setErreur(null);
    setEnCours(true);
    try {
      await call('POST', `/api/servers/${s.id}/test`);
    } catch (err) {
      setErreur(err instanceof Error ? err.message : String(err));
    } finally {
      setEnCours(false);
    }
  };
  const testEnCours = enCours || (test !== undefined && test.finishedAt === null);
  const vivants = status.agents?.vivants ?? 0;
  return (
    <div className={`nav-vps-carte nav-vps-carte--${etat}`} data-node={id} data-etat={etat}>
      <Link
        to={`/serveurs/${s.id}/discussion`}
        className="nav-vps-entete"
        data-node={`${id}.ouvrir`}
        aria-current={pathname.startsWith(`/serveurs/${s.id}/`) ? 'page' : undefined}
      >
        <IconeServeur state={status.state} taille={15} />
        <span className="barre-gauche-sujet-nom">{s.name}</span>
        <span className="nav-vps-etat" data-node={`${id}.etat`}>
          {LIBELLE[etat]}
        </span>
      </Link>
      <p className="nav-vps-detail" data-node={`${id}.detail`}>
        {etat === 'connecte' &&
          [
            status.latencyMs !== null ? `${status.latencyMs} ms` : null,
            `${vivants} agent${vivants > 1 ? 's' : ''} actif${vivants > 1 ? 's' : ''}`,
            s.keepSession ? 'session persistante' : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        {etat === 'reconnexion' && 'A-I-D reprend le lien, les agents continuent sur le serveur.'}
        {etat === 'suivi-coupe' &&
          `L’agent continue peut-être sur le serveur, A-I-D ne le suit plus${
            status.agents?.dernierEvenement
              ? ` (dernier signe ${depuis(status.agents.dernierEvenement)})`
              : ''
          }.`}
        {etat === 'session-perdue' && 'La reprise de la session a échoué.'}
        {etat === 'injoignable' &&
          (testEnCours ? 'Test de connexion en cours…' : etapeEchouee(test, status))}
        {etat === 'inconnu' && 'Pas encore contrôlé.'}
      </p>
      {etat === 'suivi-coupe' && (
        <Link
          className="bouton bouton--contour nav-vps-action"
          to={discussion}
          data-node={`${id}.action`}
        >
          Reconnecter
        </Link>
      )}
      {etat === 'session-perdue' && (
        <Link
          className="bouton bouton--contour nav-vps-action"
          to={discussion}
          data-node={`${id}.action`}
        >
          Reprendre…
        </Link>
      )}
      {etat === 'injoignable' && (
        <button
          type="button"
          className="bouton bouton--contour nav-vps-action"
          data-node={`${id}.action`}
          disabled={testEnCours}
          onClick={() => void diagnostiquer()}
        >
          Diagnostiquer
        </button>
      )}
      {erreur && (
        <p className="barre-gauche-erreur" role="status" data-node={`${id}.erreur`}>
          {erreur}
        </p>
      )}
    </div>
  );
}

export function NavVps({ n }: { n: (rest: string) => string }) {
  const { servers, statuses, tests, erreur } = useServeurs();
  return (
    <div className="nav-vps" data-node={n('vps')}>
      <div className="barre-gauche-serveurs-entete">
        <h2 className="titre-zone">
          <Link to="/serveurs" className="barre-gauche-serveurs-lien" data-node={n('vps.liste')}>
            VPS
          </Link>
        </h2>
        <Link
          to="/serveurs/nouveau"
          className="barre-gauche-actions"
          data-node={n('vps.ajouter')}
          aria-label="Ajouter un serveur"
          title="Ajouter un serveur"
        >
          +
        </Link>
      </div>
      {servers === null && erreur && (
        <p
          className="barre-gauche-serveurs-vide texte-faible"
          role="status"
          data-node={n('vps.erreur')}
        >
          Serveurs indisponibles
        </p>
      )}
      {servers !== null && servers.length === 0 && (
        <p className="barre-gauche-serveurs-vide texte-faible" data-node={n('vps.vide')}>
          Aucun serveur
        </p>
      )}
      {(servers ?? []).map((s) => (
        <Carte
          key={s.id}
          n={n}
          s={s}
          status={statuses[s.id] ?? statutInconnu(s.id)}
          test={tests[s.id]}
        />
      ))}
    </div>
  );
}
