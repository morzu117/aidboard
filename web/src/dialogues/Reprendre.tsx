import { type FormEvent, useState } from 'react';
import { useNavigate } from 'react-router';
import type { Agent, ServerAgent, Topic } from '../../../src/shared/model.js';
import { AidApiError } from '../data/api.js';
import { useSonde } from '../data/reprise.js';
import { useAidClient } from '../data/useAidState.js';
import { depuis } from '../ui/depuis.js';
import {
  boutonReprise,
  type CibleReprise,
  LIBELLE,
  type OptionReprise,
  optionsReprise,
  type Processus,
  REVIENT,
  titreReprise,
} from '../ui/repriseVue.js';
import { agentView, isResumable } from '../ui/Statut.js';
import { Dialogue } from './Dialogue.js';

// Chantier 28 (D146, D147) : que retrouver d'un agent qui ne vit plus, ou dont le suivi est coupé. Les règles sont
// dans optionsReprise() ; ici, la sonde, le choix et l'appel.

export type AReprendre =
  | { lieu: 'local'; agent: Agent; topic: Topic }
  | { lieu: 'serveur'; agent: ServerAgent; serverId: string };

const OPTIONS: OptionReprise[] = ['reconnecter', 'reprendre', 'transferer'];

const PROCESSUS: Record<Processus, string> = {
  vivant: 'il répond sur le serveur',
  arrete: 'arrêté sur le serveur',
  injoignable: 'serveur injoignable',
};

const message = (err: unknown) => (err instanceof AidApiError ? err.message : String(err));

export function Reprendre({ cible, onClose }: { cible: AReprendre; onClose: () => void }) {
  const navigate = useNavigate();
  const client = useAidClient();
  const { sonde, verifier } = useSonde(cible.lieu === 'serveur' ? cible.agent.id : null);
  const [choix, setChoix] = useState<OptionReprise | null>(null);
  const [envoi, setEnvoi] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const n = (rest: string) => `reprendre.${rest}`;

  const vue: CibleReprise =
    cible.lieu === 'local'
      ? {
          lieu: 'local',
          kind: cible.agent.kind,
          reprenable: isResumable(cible.agent),
          session: cible.agent.sessionId !== null,
          sujetOuvert: cible.topic.state === 'active' && !cible.topic.worktreeMissing,
        }
      : {
          lieu: 'serveur',
          kind: cible.agent.kind,
          session: cible.agent.sessionId !== null,
          suivi: cible.agent.suivi,
          processus: sonde?.etat ?? null,
        };
  const options = optionsReprise(vue);
  // un choix devenu impossible (nouvelle sonde) revient au défaut
  const choisi = choix && options[choix].possible ? choix : options.defaut;

  const processus =
    cible.lieu === 'local'
      ? agentView(cible.agent).label.toLowerCase()
      : sonde
        ? PROCESSUS[sonde.etat]
        : 'vérification…';
  const dernier =
    cible.lieu === 'local'
      ? (cible.agent.statusAt ?? cible.agent.updatedAt)
      : (sonde?.dernierEvenement ?? cible.agent.updatedAt);

  async function valider(e: FormEvent) {
    e.preventDefault();
    // Transférer arrive avec son choix d'agent (28.9)
    if (!choisi || choisi === 'transferer') return;
    setEnvoi(true);
    setErreur(null);
    try {
      if (cible.lieu === 'local') {
        await client.request('POST', `/api/agents/${cible.agent.id}/reprendre`);
        navigate(`/sujets/${cible.topic.id}?agent=${cible.agent.id}`);
      } else {
        const route = choisi === 'reconnecter' ? 'rattacher' : 'relancer';
        await client.request('POST', `/api/server-agents/${cible.agent.id}/${route}`);
        navigate(`/serveurs/${cible.serverId}/discussions/${cible.agent.discussionId}`);
      }
      onClose();
    } catch (err) {
      setErreur(message(err));
      setEnvoi(false);
      // l'état a pu changer sur le serveur : la sonde le redit
      if (cible.lieu === 'serveur') verifier();
    }
  }

  return (
    <Dialogue titre={titreReprise(vue)} onClose={onClose}>
      <form className="reprendre" data-node={n('formulaire')} onSubmit={valider}>
        <ul className="reprendre-situation" data-node={n('situation')}>
          <li data-node={n('situation.processus')}>Processus : {processus}</li>
          <li data-node={n('situation.dernier')}>Dernier événement : {depuis(dernier)}</li>
          <li data-node={n('situation.relance')}>Aucune tâche n’a été relancée.</li>
        </ul>
        {cible.lieu === 'serveur' && (
          <button
            className="bouton bouton--fantome reprendre-verifier"
            data-node={n('verifier')}
            type="button"
            onClick={verifier}
            disabled={envoi || sonde === null}
          >
            Vérifier à nouveau
          </button>
        )}
        <fieldset className="reprendre-options" disabled={envoi}>
          <legend data-node={n('question')}>Que veux-tu retrouver ?</legend>
          {OPTIONS.map((o) => {
            const d = options[o];
            return (
              <label
                key={o}
                className={`reprendre-option${d.possible ? '' : ' reprendre-option--grisee'}`}
                data-node={n(`option-${o}`)}
              >
                <input
                  type="radio"
                  name="reprendre-option"
                  value={o}
                  checked={choisi === o}
                  disabled={!d.possible}
                  onChange={() => setChoix(o)}
                />
                <span className="reprendre-option-corps">
                  <span className="reprendre-option-titre">{LIBELLE[o]}</span>
                  {d.possible ? (
                    <>
                      <span data-node={n(`option-${o}.revient`)}>
                        Revient : {REVIENT[o].revient}
                      </span>
                      <span data-node={n(`option-${o}.ne-revient-pas`)}>
                        Ne revient pas : {REVIENT[o].neRevientPas}
                      </span>
                    </>
                  ) : (
                    <span className="texte-discret" data-node={n(`option-${o}.raison`)}>
                      {d.raison}
                    </span>
                  )}
                </span>
              </label>
            );
          })}
        </fieldset>
        {erreur && (
          <p className="message-erreur" role="alert" data-node={n('erreur')}>
            {erreur}
          </p>
        )}
        <div className="dialogue-actions">
          <button className="bouton bouton--fantome" type="button" onClick={onClose}>
            Annuler
          </button>
          <button
            className="bouton bouton--primaire"
            type="submit"
            data-node={n('valider')}
            disabled={envoi || !choisi || choisi === 'transferer'}
          >
            {choisi ? boutonReprise(choisi) : 'Reprendre'}
          </button>
        </div>
      </form>
    </Dialogue>
  );
}
