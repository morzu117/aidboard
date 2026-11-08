import { type FormEvent, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import type { GitTransfert } from '../../../src/shared/git.js';
import type { Agent, ServerAgent, Topic } from '../../../src/shared/model.js';
import { AidApiError } from '../data/api.js';
import { useActionSuivie } from '../data/livraison.js';
import { memorySlug } from '../data/memory.js';
import { useSonde, useTransfert } from '../data/reprise.js';
import { useAid, useAidClient } from '../data/useAidState.js';
import { depuis } from '../ui/depuis.js';
import {
  alerteTransfert,
  boutonReprise,
  type CibleReprise,
  LIBELLE,
  messageTransfert,
  type OptionReprise,
  optionsReprise,
  type Processus,
  REVIENT,
  titreReprise,
} from '../ui/repriseVue.js';
import { agentView, isAlive, isResumable } from '../ui/Statut.js';
import { Dialogue } from './Dialogue.js';

// Chantier 28 (D146, D147) : que retrouver d'un agent qui ne vit plus, ou dont le suivi est coupé. Les règles sont
// dans optionsReprise() ; ici, la sonde, le choix et l'appel. Transférer (D149) confie la branche à un autre
// agent : l'ancien est arrêté s'il vit, le nouveau reçoit messageTransfert().

export type AReprendre =
  | { lieu: 'local'; agent: Agent; topic: Topic }
  | { lieu: 'serveur'; agent: ServerAgent; serverId: string };

const OPTIONS: OptionReprise[] = ['reconnecter', 'reprendre', 'transferer'];
const AGENTS = ['claude', 'codex'] as const;
type Vers = (typeof AGENTS)[number];

const PROCESSUS: Record<Processus, string> = {
  vivant: 'il répond sur le serveur',
  arrete: 'arrêté sur le serveur',
  injoignable: 'serveur injoignable',
};

const message = (err: unknown) => (err instanceof AidApiError ? err.message : String(err));

export function Reprendre({ cible, onClose }: { cible: AReprendre; onClose: () => void }) {
  const navigate = useNavigate();
  const client = useAidClient();
  const { state } = useAid();
  const { sonde, verifier } = useSonde(cible.lieu === 'serveur' ? cible.agent.id : null);
  const local = cible.lieu === 'local' ? cible : null;
  const transfert = useTransfert(local?.topic.id ?? null);
  const pousser = useActionSuivie(local?.topic.id ?? '');
  // D149 : par défaut, l'autre agent que celui d'origine
  const [vers, setVers] = useState<Vers>(cible.agent.kind === 'claude' ? 'codex' : 'claude');
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

  // poussé : la branche est relue, l'alerte suit
  const relireTransfert = transfert.relire;
  useEffect(() => {
    if (pousser.reussi) relireTransfert();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- une relecture par poussée réussie
  }, [pousser.reussi]);
  const alerte = transfert.git ? alerteTransfert(transfert.git) : null;

  async function transferer(c: { agent: Agent; topic: Topic }) {
    const ws = state?.workspaces.find((w) => w.id === c.topic.workspaceId);
    const namespace = ws?.namespace ?? ws?.name ?? '';
    if (isAlive(c.agent)) await client.request('DELETE', `/api/agents/${c.agent.id}`);
    const nouveau = await client.request<Agent>('POST', '/api/agents', {
      topicId: c.topic.id,
      kind: vers,
    });
    const page = `/sujets/${c.topic.id}?agent=${nouveau.id}`;
    try {
      const git =
        transfert.git ??
        (await client.request<GitTransfert>('GET', `/api/topics/${c.topic.id}/git/transfert`));
      const { slugs } = await client.request<{ slugs: string[] }>(
        'GET',
        `/api/memory/pages?prefix=${encodeURIComponent(`${namespace}/`)}`,
      );
      const pages = (['plan', 'dev-handoff'] as const)
        .map((k) => memorySlug(namespace, k, c.topic.slug))
        .filter((s) => slugs.includes(s));
      await client.request('POST', `/api/agents/${nouveau.id}/input`, {
        text: messageTransfert({ ancien: c.agent.kind, git, pages }),
      });
      navigate(page);
    } catch (err) {
      // le nouvel agent existe : son sujet s'ouvre, avec l'erreur (comme Nouveau sujet, D145)
      navigate(page, { state: { erreurAgent: message(err) } });
    }
  }

  async function valider(e: FormEvent) {
    e.preventDefault();
    if (!choisi) return;
    setEnvoi(true);
    setErreur(null);
    try {
      if (cible.lieu === 'local' && choisi === 'transferer') {
        await transferer(cible);
      } else if (cible.lieu === 'local') {
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
        {local && choisi === 'transferer' && (
          <div className="reprendre-transfert" data-node={n('transfert')}>
            <label className="reprendre-transfert-agent">
              Agent
              <select
                className="selecteur"
                data-node={n('transfert.agent')}
                value={vers}
                onChange={(e) => setVers(e.target.value as Vers)}
                disabled={envoi}
              >
                {AGENTS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </label>
            {alerte?.nonPousses && (
              <div className="reprendre-alerte" data-node={n('transfert.non-pousses')}>
                {alerte.nonPousses}{' '}
                {pousser.confirmation.attente ?? (
                  <button
                    className="bouton bouton--contour"
                    data-node={n('transfert.pousser')}
                    data-action="git.pousser"
                    type="button"
                    disabled={envoi || pousser.enCours}
                    onClick={() => void pousser.lancer('git.pousser')}
                  >
                    {pousser.enCours ? 'Poussée…' : 'Pousser d’abord'}
                  </button>
                )}
              </div>
            )}
            {pousser.echec && (
              <p className="message-erreur" role="alert" data-node={n('transfert.pousser-echec')}>
                {pousser.echec}
              </p>
            )}
            {alerte?.nonCommites && (
              <p className="reprendre-alerte" data-node={n('transfert.non-commites')}>
                {alerte.nonCommites}
              </p>
            )}
          </div>
        )}
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
            disabled={envoi || !choisi}
          >
            {choisi ? boutonReprise(choisi, vers) : 'Reprendre'}
          </button>
        </div>
      </form>
    </Dialogue>
  );
}
