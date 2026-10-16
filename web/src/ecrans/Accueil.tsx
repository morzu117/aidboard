import { useState } from 'react';
import { useAid } from '../data/useAidState.js';
import { Layout, useLayout } from '../ui/Layout.js';
import { CarteSujet } from './CarteSujet.js';
import { CasErreurWorktree } from './CasErreurWorktree.js';

function Squelettes() {
  return (
    <div className="grille" data-node="1-1.grille" aria-label="Chargement des sujets">
      {[1, 2, 3, 4, 5, 6].map((n) => (
        <div key={n} className="squelette" data-node={`1-1.grille.squelette-${n}`}>
          <div className="entete-texte" data-node={`1-1.grille.squelette-${n}.entete`}>
            <span className="sq sq--titre" />
            <span className="sq sq--ligne sq--court" />
          </div>
          <span className="sq sq--puce" />
          <div className="entete-texte" data-node={`1-1.grille.squelette-${n}.terminal`}>
            <span className="sq sq--bloc" />
          </div>
          <div className="entete-texte" data-node={`1-1.grille.squelette-${n}.message`}>
            <span className="sq sq--champ" />
          </div>
        </div>
      ))}
    </div>
  );
}

function BandeauDaemon() {
  const { daemon, retry } = useAid();
  const expired = daemon === 'session-expiree';
  return (
    <div className="bandeau-erreur" data-node="1-1.erreur.bandeau" role="alert">
      <div className="bandeau-texte">
        <p className="bandeau-titre" data-node="1-1.erreur.bandeau.titre">
          Impossible de lire l’état des sujets
        </p>
        <p className="texte-discret" data-node="1-1.erreur.bandeau.cause" data-bind="erreur.cause">
          {expired
            ? 'Cause : la session a expiré (le daemon a redémarré).'
            : `Cause : le daemon est injoignable sur ${window.location.host} (connexion refusée).`}
        </p>
        <p className="texte-faible" data-node="1-1.erreur.bandeau.aide">
          {expired
            ? 'Relance aid open pour obtenir un nouveau lien.'
            : 'Relance-le avec aid dans un terminal, puis réessaie.'}
        </p>
      </div>
      {!expired && (
        <button
          className="bouton bouton--contour"
          data-node="1-1.erreur.bandeau.reessayer"
          data-action="daemon.reconnecter"
          type="button"
          onClick={retry}
        >
          Réessayer
        </button>
      )}
    </div>
  );
}

function Contenu() {
  const { state, daemon } = useAid();
  const { openNewTopic, openNewWorkspace } = useLayout();
  const [filtre, setFiltre] = useState<string | null>(null);
  const down = daemon === 'injoignable' || daemon === 'session-expiree';

  if (!state) {
    return (
      <main className="page">
        <div className="entete" data-node="1-1.entete">
          <div className="entete-texte">
            <h1 className="titre-ecran" data-node="1-1.entete.titre">
              Sujets ouverts
            </h1>
            {down ? (
              <p className="resume">État indisponible</p>
            ) : (
              <span className="sq sq--ligne sq--moyen" />
            )}
          </div>
        </div>
        {down ? (
          <section className="zone-erreur" data-node="1-1.erreur">
            <BandeauDaemon />
          </section>
        ) : (
          <Squelettes />
        )}
      </main>
    );
  }

  const topics = state.topics.filter((t) => !filtre || t.workspaceId === filtre);
  const wsOf = (id: string) => state.workspaces.find((w) => w.id === id);
  const agentsOf = (topicId: string) => {
    const runIds = state.runs.filter((r) => r.topicId === topicId).map((r) => r.id);
    return state.agents.filter((a) => runIds.includes(a.runId));
  };
  const total = state.topics.length;
  const sains = topics.filter((t) => !t.worktreeMissing);
  const casses = topics.filter((t) => t.worktreeMissing);

  return (
    <main className="page">
      <div className="entete" data-node="1-1.entete">
        <div className="entete-texte">
          <h1 className="titre-ecran" data-node="1-1.entete.titre">
            Sujets ouverts
          </h1>
          <p className="resume" data-node="1-1.entete.resume">
            <span data-node="1-1.entete.resume.sujets" data-bind="resume.sujets">
              {total}
            </span>{' '}
            {total > 1 ? 'sujets ouverts' : 'sujet ouvert'}
          </p>
        </div>
        <div className="entete-droite">
          <button
            className="bouton"
            data-action="workspace.ajouter"
            type="button"
            onClick={openNewWorkspace}
          >
            Ajouter un projet
          </button>
          {state.workspaces.length > 0 && (
            <div className="filtres" data-node="1-1.filtres">
              <div className="groupe-filtres" role="group" aria-label="Filtrer par projet">
                <button
                  className={`puce-filtre${filtre === null ? ' est-actif' : ''}`}
                  data-node="1-1.filtres.workspace-tous"
                  data-action="filtre.workspace"
                  type="button"
                  aria-pressed={filtre === null}
                  onClick={() => setFiltre(null)}
                >
                  Tous
                </button>
                {state.workspaces.map((w, i) => (
                  <button
                    key={w.id}
                    className={`puce-filtre${filtre === w.id ? ' est-actif' : ''}`}
                    data-node={`1-1.filtres.workspace-${i + 1}`}
                    data-action="filtre.workspace"
                    type="button"
                    aria-pressed={filtre === w.id}
                    onClick={() => setFiltre(w.id)}
                  >
                    <span
                      data-node={`1-1.filtres.workspace-${i + 1}.nom`}
                      data-bind="workspace.nom"
                    >
                      {w.name}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
      {down && (
        <section className="zone-erreur" data-node="1-1.erreur">
          <BandeauDaemon />
        </section>
      )}
      {state.workspaces.length > 0 && (
        <section className="projets" aria-label="Projets">
          {state.workspaces.map((w) => {
            const n = state.topics.filter((t) => t.workspaceId === w.id).length;
            return (
              <div key={w.id} className="projet">
                <div className="projet-texte">
                  <strong>{w.name}</strong>
                  <span className="projet-chemin">{w.root}</span>
                </div>
                <span className="texte-faible">
                  {n === 0 ? 'aucun sujet' : n === 1 ? '1 sujet' : `${n} sujets`}
                </span>
                <button
                  className="bouton bouton--contour"
                  type="button"
                  aria-label={`Nouveau sujet dans ${w.name}`}
                  onClick={() => openNewTopic(w.id)}
                >
                  Nouveau sujet
                </button>
              </div>
            );
          })}
        </section>
      )}
      {total === 0 ? (
        <section className="vide" data-node="1-1.vide">
          <p className="vide-message" data-node="1-1.vide.message">
            {state.workspaces.length > 0
              ? 'Aucun sujet ouvert : un projet peut attendre, crée un sujet quand tu en as un.'
              : 'Aucun projet : ajoutes-en un, puis crée un sujet pour démarrer.'}
          </p>
          <p className="texte-discret" data-node="1-1.vide.aide">
            Chaque sujet aura sa branche et son worktree, créés hors du repo.
          </p>
          <div className="vide-actions">
            <button
              className="bouton bouton--primaire"
              data-node="1-1.vide.creer"
              data-action="sujet.creer"
              type="button"
              onClick={() => openNewTopic()}
            >
              Nouveau sujet
            </button>
          </div>
        </section>
      ) : (
        <>
          <div className="grille" data-node="1-1.grille">
            {sains.map((t, i) => (
              <CarteSujet
                key={t.id}
                n={i + 1}
                topic={t}
                workspace={wsOf(t.workspaceId)}
                agents={agentsOf(t.id)}
              />
            ))}
          </div>
          {casses.map((t, i) => (
            <CasErreurWorktree key={t.id} n={i + 1} topic={t} workspace={wsOf(t.workspaceId)} />
          ))}
        </>
      )}
    </main>
  );
}

export function Accueil() {
  return (
    <Layout screen="1-1">
      <Contenu />
    </Layout>
  );
}
