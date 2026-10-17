import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { GitBranch, GitBranchesResponse } from '../../../src/shared/git.js';
import { AidApiError } from '../data/api.js';
import { useAid } from '../data/useAidState.js';
import { Dialogue } from './Dialogue.js';

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

// 11.6 (écran 3.3) : liste des branches locales (11.5), filtre, confirmation avant le
// changement effectif. « branche.recreer » (branche extraite ailleurs) n'a pas de contrat
// backend dans ce chantier : l'option mène au sujet propriétaire quand il est connu (data
// déjà là via topicId), sinon reste un texte descriptif non activable.
export function SelecteurBranche({ topicId, onClose }: { topicId: string; onClose: () => void }) {
  const { state, outputs, call } = useAid();
  const [branches, setBranches] = useState<GitBranch[] | null>(null);
  const [erreurChargement, setErreurChargement] = useState<string | null>(null);
  const [filtre, setFiltre] = useState('');
  const [cible, setCible] = useState<GitBranch | null>(null);
  const [actionId, setActionId] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [erreurAction, setErreurAction] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    call<GitBranchesResponse>('GET', `/api/topics/${topicId}/git/branches`).then(
      (r) => {
        if (!cancelled) setBranches(r.branches);
      },
      (err: unknown) => {
        if (!cancelled) setErreurChargement(err instanceof AidApiError ? err.message : String(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [call, topicId]);

  const action = state?.actions.find((a) => a.id === actionId);
  useEffect(() => {
    if (action?.state === 'succeeded') onClose();
  }, [action?.state, onClose]);

  async function changer(branch: GitBranch, dirtyAction?: 'stash') {
    setErreurAction(null);
    setRequesting(true);
    setActionId(null);
    try {
      const r = await call<{ actionId: string }>(
        'POST',
        `/api/topics/${topicId}/actions/topic.branch-changer`,
        { targetBranch: branch.name, ...(dirtyAction && { dirtyAction }) },
      );
      setActionId(r.actionId);
    } catch (err) {
      setErreurAction(err instanceof AidApiError ? err.message : String(err));
    } finally {
      setRequesting(false);
    }
  }

  const mots = fold(filtre).split(/\s+/).filter(Boolean);
  const correspond = (b: GitBranch) => mots.every((m) => fold(b.name).includes(m));
  const mienne = branches?.find((b) => b.isCurrent);
  const autres = (branches ?? []).filter((b) => !b.isCurrent).filter(correspond);

  const enCours = requesting || (actionId !== null && (!action || action.state === 'running'));
  const echoue =
    !enCours && actionId !== null && action !== undefined && action.state !== 'succeeded';
  const besoinHumain = echoue && action!.state === 'needs_human';
  const messageEchec =
    erreurAction ??
    (echoue
      ? (outputs[actionId!]?.at(-1)?.line ??
        (besoinHumain
          ? 'Modifications non commitées : le changement de branche les écraserait.'
          : 'Le changement de branche a échoué.'))
      : null);

  function annulerConfirmation() {
    setCible(null);
    setErreurAction(null);
    setActionId(null);
  }

  return (
    <Dialogue titre="Changer de branche" onClose={onClose}>
      {cible ? (
        <div className="confirmation" data-node="1-3.selecteur.confirmation">
          <p className="confirmation-titre">Passer le worktree sur {cible.name} ?</p>
          <p className="commande" data-bind="action.commande">
            git switch {cible.name}
          </p>
          {messageEchec && (
            <p className="message-erreur" role="alert">
              {messageEchec}
            </p>
          )}
          <div className="dialogue-actions">
            <button
              className="bouton bouton--fantome"
              type="button"
              disabled={enCours}
              onClick={annulerConfirmation}
            >
              Annuler
            </button>
            {besoinHumain ? (
              <button
                className="bouton bouton--primaire"
                type="button"
                disabled={enCours}
                onClick={() => void changer(cible, 'stash')}
              >
                Mettre de côté et changer
              </button>
            ) : (
              <button
                className="bouton bouton--primaire"
                type="button"
                disabled={enCours}
                onClick={() => void changer(cible)}
              >
                Changer de branche
              </button>
            )}
          </div>
        </div>
      ) : (
        <>
          <input
            className="champ"
            type="text"
            placeholder="Filtrer les branches…"
            aria-label="Filtrer les branches"
            value={filtre}
            onChange={(e) => setFiltre(e.target.value)}
            autoFocus
          />
          {erreurChargement && (
            <p className="message-erreur" role="alert">
              {erreurChargement}
            </p>
          )}
          {branches && (
            <div className="selecteur-branche__liste" role="listbox" aria-label="Branches">
              {mienne && correspond(mienne) && (
                <div
                  className="selecteur-branche__groupe"
                  role="group"
                  aria-label="Branche du sujet"
                >
                  <h3 className="titre-zone">Branche du sujet</h3>
                  <span
                    className="selecteur-branche__option est-courante"
                    role="option"
                    aria-selected="true"
                  >
                    <span aria-hidden="true">✓</span>
                    <span className="selecteur-branche__nom">{mienne.name}</span>
                  </span>
                </div>
              )}
              <div className="selecteur-branche__groupe" role="group" aria-label="Locales">
                <h3 className="titre-zone">Locales</h3>
                {autres.length === 0 ? (
                  <p className="selecteur-branche__vide">Aucune branche ne correspond au filtre.</p>
                ) : (
                  autres.map((b) => {
                    const ailleurs = b.worktree !== null;
                    // Un <a> ne peut pas vivre dans un <button> (HTML invalide) : la ligne
                    // extraite ailleurs n'est pas activable, donc pas un bouton — un simple
                    // conteneur role="option" avec son lien « Aller au sujet » à côté.
                    return ailleurs ? (
                      <div
                        key={b.name}
                        role="option"
                        aria-selected="false"
                        aria-disabled="true"
                        className="selecteur-branche__option"
                      >
                        <span className="selecteur-branche__nom">{b.name}</span>
                        <span className="selecteur-branche__meta">
                          déjà extraite dans {b.worktree}
                        </span>
                        {b.topicId && (
                          <Link className="selecteur-branche__lien" to={`/sujets/${b.topicId}`}>
                            Aller au sujet
                          </Link>
                        )}
                      </div>
                    ) : (
                      <button
                        key={b.name}
                        type="button"
                        role="option"
                        aria-selected="false"
                        className="selecteur-branche__option"
                        onClick={() => setCible(b)}
                      >
                        <span className="selecteur-branche__nom">{b.name}</span>
                        <span className="selecteur-branche__meta">
                          ↑{b.ahead} ↓{b.behind}
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          )}
        </>
      )}
    </Dialogue>
  );
}
