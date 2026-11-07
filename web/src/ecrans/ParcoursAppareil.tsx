export { NotificationsAppareil } from '../ui/NotificationsAppareil.js';
import { attendDecision } from '../../../src/shared/decision.js';
import { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import type { EtatPourAppareil } from '../../../src/shared/host.js';
import { useAid, useAidClient } from '../data/useAidState.js';
import { AidApiError } from '../data/api.js';
import { Decision, Tour } from '../ui/ActionsAppareil.js';

export { attendDecision } from '../../../src/shared/decision.js';
const agentsDuSujet = (etat: EtatPourAppareil, id: string) => {
  const runs = new Set(etat.runs.filter((run) => run.topicId === id).map((run) => run.id));
  return etat.agents.filter((agent) => runs.has(agent.runId));
};
const chemin = (id: string) => `/sujets/${encodeURIComponent(id)}`;

export function SujetsAppareil() {
  const { appareil } = useAid();
  const [filtre, setFiltre] = useState<string | null>(null);
  return (
    <main className="page">
      <h1 className="titre-ecran">Sujets</h1>
      <div role="group" aria-label="Filtrer par état" className="appareil-actions">
        {[null, ...new Set(appareil?.topics.map((sujet) => sujet.state))].map((etat) => (
          <button
            key={etat ?? 'tous'}
            aria-pressed={filtre === etat}
            onClick={() => setFiltre(etat)}
          >
            {etat ?? 'Tous'}
          </button>
        ))}
      </div>
      <ul className="appareil-sujets">
        {appareil?.topics
          .filter((sujet) => filtre === null || sujet.state === filtre)
          .map((sujet) => (
            <li key={sujet.id}>
              <Link to={chemin(sujet.id)}>
                {agentsDuSujet(appareil, sujet.id).some(attendDecision) ? (
                  <strong>{sujet.title}</strong>
                ) : (
                  sujet.title
                )}
              </Link>
              <p>{sujet.phase ?? sujet.state}</p>
            </li>
          ))}
      </ul>
    </main>
  );
}

export function SuivreAppareil({ relire = false }: { relire?: boolean }) {
  const { id } = useParams();
  const { appareil, horsLigne } = useAid();
  const lecture = useLivraisonAppareil(id);
  const sujet = appareil?.topics.find((sujet) => sujet.id === id);
  if (!appareil) return <main className="page" />;
  if (!sujet)
    return (
      <main className="page">
        <h1>Sujet introuvable</h1>
        <Link to="/sujets">Sujets</Link>
      </main>
    );
  const agents = agentsDuSujet(appareil, sujet.id);
  const decision = agents.find(attendDecision);
  const tours = agents
    .filter((agent) => agent.tour)
    .sort((a, b) => (b.statusAt ?? '').localeCompare(a.statusAt ?? ''));
  const dernier = tours[0];
  const livraison =
    sujet.prNumber !== null || !!lecture?.livraison?.head || !!lecture?.livraison?.fichiers.length;
  return (
    <main className="page">
      <Link to={relire ? chemin(sujet.id) : '/sujets'}>{relire ? sujet.title : 'Sujets'}</Link>
      <h1 className="titre-ecran">{relire ? 'Relire un tour' : sujet.title}</h1>
      {relire && lecture?.livraison && (
        <FichiersAppareil id={sujet.id} livraison={lecture.livraison} />
      )}
      {relire ? (
        dernier ? (
          <Tour key={`${dernier.id}:${dernier.tour!.id}`} agent={dernier} horsLigne={!!horsLigne} />
        ) : (
          <p>Aucun tour disponible.</p>
        )
      ) : (
        <>
          {decision && (
            <section aria-label="Prochaine décision">
              <h2>Prochaine décision</h2>
              <Decision
                key={`${decision.id}:${decision.question?.pendingId}`}
                agent={decision}
                horsLigne={!!horsLigne}
              />
            </section>
          )}
          <p>Phase ou état : {sujet.phase ?? sujet.state}</p>
          {dernier && (
            <section aria-label="Dernier tour">
              <h2>Dernier tour</h2>
              <p>{dernier.tour!.resume}</p>
              <Link to={`${chemin(sujet.id)}/tour`}>Relire un tour</Link>
            </section>
          )}
          {livraison && <Link to={`${chemin(sujet.id)}/livraison`}>Livrer</Link>}
        </>
      )}
    </main>
  );
}

type Livraison = {
  head: string | null;
  fichiers: Array<{ nom: string; ajouts: number; retraits: number }>;
  controles: Array<{ nom: string; etat: string }>;
  revue: { etat: string; surLaTete: boolean };
  blocage: string | null;
  prNumber: number | null;
};

function useLivraisonAppareil(id: string | undefined) {
  const client = useAidClient();
  const { horsLigne } = useAid();
  const [lecture, setLecture] = useState<{
    id: string;
    livraison?: Livraison;
    erreur?: string;
  } | null>(null);
  useEffect(() => {
    if (!id || horsLigne) return;
    let actif = true;
    void client
      .request<Livraison>('GET', `/api/appareils/sujets/${encodeURIComponent(id)}/livraison`)
      .then(
        (livraison) => {
          if (actif) setLecture({ id, livraison });
        },
        () => {
          if (actif) setLecture({ id, erreur: 'Livraison indisponible.' });
        },
      );
    return () => {
      actif = false;
    };
  }, [client, id, horsLigne]);
  return lecture && lecture.id === id ? lecture : null;
}

export function LivraisonAppareil() {
  const { id } = useParams();
  const { horsLigne } = useAid();
  const lecture = useLivraisonAppareil(id);
  const livraison = lecture && lecture.id === id ? lecture.livraison : undefined;
  return (
    <main className="page">
      <Link to={chemin(id ?? '')}>Suivre le sujet</Link>
      <h1 className="titre-ecran">Autoriser un merge</h1>
      {lecture && lecture.id === id && lecture.erreur && <p role="alert">{lecture.erreur}</p>}
      {horsLigne && !livraison && <p>Livraison indisponible hors ligne.</p>}
      {livraison && (
        <>
          <p>Tête : {livraison.head ?? 'inconnue'}</p>
          <h2>Fichiers</h2>
          <FichiersAppareil id={id!} livraison={livraison} />
          <h2>Contrôles</h2>
          <ul>
            {livraison.controles.map((controle, index) => (
              <li key={index}>
                {controle.nom} : {controle.etat}
              </li>
            ))}
          </ul>
          <h2>Revue</h2>
          <p>
            {livraison.revue.etat} ·{' '}
            {livraison.revue.surLaTete ? 'Sur la tête' : 'Ne porte pas sur la tête'}
          </p>
          <h2>Blocage</h2>
          <p>{livraison.blocage ?? 'Aucun blocage'}</p>
          <p>PR : {livraison.prNumber === null ? 'aucune' : `#${livraison.prNumber}`}</p>
        </>
      )}
      <div className="appareil-actions">
        <button disabled>Merger</button>
      </div>
      <p>Le merge se confirme sur le Mac.</p>
    </main>
  );
}

export function InformationsAppareil() {
  const { appareil } = useAid();
  return (
    <main className="page">
      <h1 className="titre-ecran">Informations</h1>
      {appareil && (
        <>
          <p>Cell swarph : {appareil.mesh?.state.cell ?? 'non connectée'}</p>
          <p>Sujets : {appareil.topics.length}</p>
          <p>Agents : {appareil.agents.length}</p>
        </>
      )}
    </main>
  );
}

export function BadgeAppareil() {
  const { appareil } = useAid();
  const nombre = appareil?.agents.filter(
    (agent) =>
      attendDecision(agent) &&
      appareil.runs.some(
        (run) =>
          run.id === agent.runId && appareil.topics.some((sujet) => sujet.id === run.topicId),
      ),
  ).length;
  useEffect(() => {
    if (nombre === undefined) return;
    void (async () => {
      try {
        const badge = navigator as Navigator & {
          setAppBadge?: (n: number) => Promise<void>;
          clearAppBadge?: () => Promise<void>;
        };
        if (nombre > 0) await badge.setAppBadge?.(nombre);
        else await badge.clearAppBadge?.();
      } catch {
        // Le navigateur peut refuser le badge.
      }
    })();
  }, [nombre]);
  return null;
}

function FichiersAppareil({ id, livraison }: { id: string; livraison: Livraison }) {
  return (
    <ul>
      {livraison.fichiers.map((fichier, index) => (
        <li key={index}>
          <Link to={`${chemin(id)}/fichiers/${index}`} state={{ livraison }}>
            {fichier.nom} · +{fichier.ajouts} −{fichier.retraits}
          </Link>
        </li>
      ))}
    </ul>
  );
}

const MESSAGES_DIFF: Record<string, string> = {
  sensible: 'Fichier sensible : il se lit sur le Mac.',
  binaire: 'Fichier binaire.',
  coupe: 'Suite sur le Mac.',
  code_coupe: 'La lecture du code est coupée sur le Mac.',
  perimee: 'La livraison a changé.',
  fichier: "Ce fichier n'est plus dans la livraison.",
  requete: 'Demande de diff invalide.',
};

export function FichierAppareil() {
  const { id, index } = useParams();
  const { horsLigne } = useAid();
  return <LectureFichierAppareil key={`${id}:${index}:${!!horsLigne}`} />;
}

function LectureFichierAppareil() {
  const { id, index } = useParams();
  const { state } = useLocation();
  const client = useAidClient();
  const { horsLigne } = useAid();
  const [relecture, setRelecture] = useState(0);
  const [lecture, setLecture] = useState<{
    livraison?: Livraison;
    etat: string;
    lignes?: string[];
  } | null>(null);
  useEffect(() => {
    if (horsLigne || !id) return;
    let actif = true;
    void (async () => {
      let livraison: Livraison | undefined;
      try {
        livraison = relecture === 0 ? state?.livraison : undefined;
        livraison ??= await client.request<Livraison>(
          'GET',
          `/api/appareils/sujets/${encodeURIComponent(id)}/livraison`,
        );
        if (!actif) return;
        const diff = await client.request<{ etat: string; lignes?: string[] }>(
          'GET',
          `/api/appareils/sujets/${encodeURIComponent(id)}/fichiers/${encodeURIComponent(index ?? '')}/diff?tete=${encodeURIComponent(livraison.head ?? '')}`,
        );
        if (actif) setLecture({ livraison, ...diff });
      } catch (erreur) {
        if (actif)
          setLecture({
            livraison,
            etat: erreur instanceof AidApiError ? String(erreur.body.raison) : 'indisponible',
          });
      }
    })();
    return () => {
      actif = false;
    };
  }, [client, id, index, state, relecture, horsLigne]);
  const fichier = lecture?.livraison?.fichiers[Number(index)];
  return (
    <main className="page">
      <Link to={`${chemin(id ?? '')}/livraison`}>Livrer</Link>
      <h1 className="titre-ecran">Lire un fichier</h1>
      {fichier && (
        <h2>
          {fichier.nom} · +{fichier.ajouts} −{fichier.retraits}
        </h2>
      )}
      {horsLigne ? (
        <p>Diff indisponible hors ligne.</p>
      ) : (
        lecture && (
          <>
            {lecture.lignes && (
              <pre className="appareil-diff">
                {lecture.lignes.map((ligne, i) => {
                  const classe = ligne.startsWith('@@')
                    ? 'bloc'
                    : ligne.startsWith('+')
                      ? 'ajout'
                      : ligne.startsWith('-')
                        ? 'retrait'
                        : 'contexte';
                  return (
                    <span key={i} className={`diff-${classe}`}>
                      {ligne.split('[masqué]').map((partie, j) => (
                        <span key={j}>
                          {j > 0 && <span className="diff-masque">[masqué]</span>}
                          {partie}
                        </span>
                      ))}
                      {'\n'}
                    </span>
                  );
                })}
              </pre>
            )}
            {lecture.etat !== 'ok' && (
              <p role="status">{MESSAGES_DIFF[lecture.etat] ?? 'Diff indisponible.'}</p>
            )}
            {lecture.etat === 'perimee' && (
              <div className="appareil-actions">
                <button onClick={() => setRelecture((n) => n + 1)}>Relire</button>
              </div>
            )}
          </>
        )
      )}
    </main>
  );
}
