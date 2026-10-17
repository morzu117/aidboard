import { type FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { Agent, PendingRequest, Topic, Workspace } from '../../../src/shared/model.js';
import { useAid } from '../data/useAidState.js';
import { Terminal } from '../terminal/Terminal.js';
import { agentView, Badge, isAlive, mostUrgent, Point, topicView } from '../ui/Statut.js';
import { depuis } from '../ui/depuis.js';
import { roleLabel } from '../ui/roles.js';

const APERCU_LIGNES = 6;
const APERCU_RECENTES = 3;
const APERCU_MS = 3000;
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const terminalUrl = (topicId: string, agentId: string) => `/sujets/${topicId}?agent=${agentId}`;

/** Les dernières lignes de l'écran de l'agent, en texte : elles viennent de l'agent, jamais du HTML. */
function Apercu({ dataNode, agent }: { dataNode: string; agent: Agent }) {
  const { call, state } = useAid();
  const [lines, setLines] = useState<string[]>([]);
  const alive = isAlive(agent);
  useEffect(() => {
    let off = false;
    const load = () => {
      if (document.visibilityState === 'hidden') return;
      call<{ lines: string[] }>(
        'GET',
        `/api/agents/${agent.id}/screen?lines=${APERCU_LIGNES}`,
      ).then(
        (r) => !off && setLines(r.lines ?? []),
        () => {},
      );
    };
    load();
    const timer = alive ? setInterval(load, APERCU_MS) : undefined;
    return () => {
      off = true;
      clearInterval(timer);
    };
    // un nouvel instantané (lastEventId) recharge l'aperçu
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id, alive, state?.lastEventId]);
  return (
    <div
      className="terminal"
      data-node={dataNode}
      role="log"
      aria-label={`Sortie du terminal de ${agent.kind}`}
    >
      {lines.map((l, i) => (
        <div
          key={i}
          className={`ligne${i < lines.length - APERCU_RECENTES ? ' ligne--ancienne' : ''}`}
          data-node={`${dataNode}.ligne-${i + 1}`}
          data-bind="terminal.ligne"
        >
          {l}
        </div>
      ))}
    </div>
  );
}

function Demande({
  dataNode,
  topicId,
  agent,
  pending,
}: {
  dataNode: string;
  topicId: string;
  agent: Agent;
  pending: PendingRequest;
}) {
  const { call } = useAid();
  const [busy, setBusy] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const repondre = async (answer: string) => {
    setBusy(true);
    setErreur(null);
    try {
      await call('POST', `/api/agents/${agent.id}/answer`, { pendingId: pending.id, answer });
    } catch (err) {
      setErreur(message(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="demande"
      data-node={dataNode}
      role="group"
      aria-label="Réponse attendue"
      data-type={pending.kind}
    >
      <p
        className="demande-question"
        data-node={`${dataNode}.question`}
        data-bind="demande.question"
      >
        {agent.kind} demande : {pending.question}
      </p>
      <div className="demande-options">
        {pending.options.map((o, i) => (
          <button
            key={o.answer}
            className={`bouton${i === 0 ? ' bouton--primaire' : ''}`}
            data-node={`${dataNode}.option-${i + 1}`}
            data-bind="demande.option"
            data-action="demande.repondre"
            type="button"
            disabled={busy}
            onClick={() => void repondre(o.answer)}
          >
            {o.label}
          </button>
        ))}
        {(pending.options.length === 0 || erreur) && (
          <Link
            className="lien"
            data-node={`${dataNode}.terminal`}
            data-action="terminal.ouvrir"
            to={terminalUrl(topicId, agent.id)}
          >
            Ouvrir le terminal →
          </Link>
        )}
      </div>
      {erreur && (
        <p className="message-erreur" role="alert" data-node={`${dataNode}.erreur`}>
          {erreur}
        </p>
      )}
    </div>
  );
}

function Message({ dataNode, agent }: { dataNode: string; agent: Agent }) {
  const { call } = useAid();
  const [text, setText] = useState('');
  const [erreur, setErreur] = useState<string | null>(null);
  const label = `Message à ${agent.kind}…`;
  const envoyer = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    setErreur(null);
    try {
      await call('POST', `/api/agents/${agent.id}/input`, { text });
      setText('');
    } catch (err) {
      setErreur(message(err));
    }
  };
  return (
    <>
      <form className="message" data-node={dataNode} onSubmit={(e) => void envoyer(e)}>
        <input
          className="champ"
          data-node={`${dataNode}.champ`}
          data-action="message.saisir"
          type="text"
          placeholder={agent.pausedAt ? `${agent.kind} est en pause` : label}
          aria-label={label}
          disabled={Boolean(agent.pausedAt)}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button
          className="bouton-icone bouton--primaire"
          data-node={`${dataNode}.envoyer`}
          data-action="message.envoyer"
          type="submit"
          aria-label="Envoyer"
          disabled={Boolean(agent.pausedAt)}
        >
          <svg className="icone" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M5 12h14" />
            <path d="M13 6l6 6-6 6" />
          </svg>
        </button>
      </form>
      {erreur && (
        <p className="message-erreur" role="alert" data-node={`${dataNode}.erreur`}>
          {erreur}
        </p>
      )}
    </>
  );
}

/** Le terminal en grand. Échap ferme, sauf dans le terminal : là, Échap est une touche pour l'agent. */
function Agrandi({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (e.target instanceof Element && e.target.closest('.xterm')) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="voile" data-layer="overlay">
      <div
        className="dialogue dialogue--plein"
        role="dialog"
        aria-modal="true"
        aria-label={`Terminal de ${agent.kind}`}
      >
        <div className="dialogue-titre">
          <h2>Terminal de {agent.kind}</h2>
          <button className="bouton" type="button" onClick={onClose}>
            Fermer
          </button>
        </div>
        <Terminal agentId={agent.id} visible />
      </div>
    </div>
  );
}

// DS7 côté board : le même champ relu en direct, jamais la lifecycle `indexState` du sujet.
function indexPastille(topic: Topic): string {
  const idx = topic.index;
  if (!idx) return 'index indisponible';
  if (idx.stale)
    return `${idx.engine} · ${idx.pending} fichier${idx.pending > 1 ? 's' : ''} en retard`;
  return `${idx.engine} · à jour`;
}

function activite(agent: Agent | undefined, topic: Topic) {
  if (agent?.pausedAt && isAlive(agent)) {
    const d = depuis(agent.pausedAt);
    return d.startsWith('il y a ') ? `en pause depuis ${d.slice(7)}` : 'en pause à l’instant';
  }
  return depuis(agent?.statusAt ?? topic.updatedAt);
}

export function CarteSujet({
  n,
  topic,
  workspace,
  agents,
}: {
  n: number;
  topic: Topic;
  workspace: Workspace | undefined;
  agents: Agent[];
}) {
  const { call } = useAid();
  const id = (rest: string) => `1-1.grille.sujet-${n}.${rest}`;
  const [chosen, setChosen] = useState<string | null>(null);
  const [agrandi, setAgrandi] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const urgent = mostUrgent(agents);
  const recipient = agents.find((a) => a.id === chosen) ?? urgent;
  const view = topicView(agents);
  const asking = agents.find((a) => a.pending && a.status === 'needs_input');
  const cls = view.tone === 'inactif' ? '' : ` carte--${view.tone}`;
  const pause = async (a: Agent) => {
    setErreur(null);
    try {
      await call('POST', `/api/agents/${a.id}/${a.pausedAt ? 'resume' : 'pause'}`);
    } catch (err) {
      setErreur(message(err));
    }
  };
  return (
    <article
      className={`carte${cls}`}
      data-node={`1-1.grille.sujet-${n}`}
      aria-label={topic.branch}
    >
      <div className="carte-entete">
        <Point tone={view.tone} grand estimated={view.estimated} />
        <div className="carte-ident">
          <span className="carte-branche" data-node={id('branche')} data-bind="sujet.branche">
            {topic.branch}
          </span>
          <span className="carte-sous-titre">
            <span data-node={id('workspace')} data-bind="workspace.nom">
              {workspace?.name ?? '?'}
            </span>{' '}
            ·{' '}
            <span data-node={id('titre')} data-bind="sujet.titre">
              {topic.title}
            </span>
          </span>
        </div>
        <Badge view={view} dataNode={id('statut')} agent={urgent} />
      </div>
      <div className="carte-meta">
        <span
          className="pastille pastille--local"
          data-node={id('execution')}
          data-bind="agent.transport"
        >
          local
        </span>
        <span className="pastille pastille--code" data-node={id('index')} data-bind="sujet.index">
          {indexPastille(topic)}
        </span>
        <div
          className="agents"
          data-node={id('agents')}
          role="group"
          aria-label="Destinataire des messages"
        >
          {agents.map((a, i) => {
            const v = agentView(a);
            const on = a.id === recipient?.id;
            return (
              <button
                key={a.id}
                className={`puce-agent${on ? ' est-destinataire' : ''}`}
                data-node={id(`agent-${i + 1}`)}
                data-action="agent.choisir"
                type="button"
                aria-pressed={on}
                onClick={() => setChosen(a.id)}
              >
                <Point
                  tone={v.tone}
                  label={v.label}
                  estimated={v.estimated}
                  dataNode={id(`agent-${i + 1}.statut`)}
                />
                <span data-node={id(`agent-${i + 1}.type`)} data-bind="agent.type">
                  {a.kind}
                </span>
                {a.kind !== 'shell' && (
                  <span
                    className="agent-role"
                    data-node={id(`agent-${i + 1}.role`)}
                    data-bind="agent.role"
                  >
                    {roleLabel(a.role)}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <span
          className="carte-activite"
          data-node={id('activite')}
          data-bind="sujet.derniere_activite"
        >
          {activite(recipient, topic)}
        </span>
      </div>
      {recipient && <Apercu dataNode={id('terminal')} agent={recipient} />}
      {asking?.pending && (
        <Demande
          dataNode={id('demande')}
          topicId={topic.id}
          agent={asking}
          pending={asking.pending}
        />
      )}
      {recipient && isAlive(recipient) && <Message dataNode={id('message')} agent={recipient} />}
      {erreur && (
        <p className="message-erreur" role="alert" data-node={id('actions.erreur')}>
          {erreur}
        </p>
      )}
      <div className="carte-actions" data-node={id('actions')}>
        {recipient && (
          <button
            className="bouton"
            data-node={id('actions.agrandir')}
            data-action="terminal.agrandir"
            type="button"
            onClick={() => setAgrandi(true)}
          >
            Agrandir le terminal
          </button>
        )}
        {recipient && isAlive(recipient) && (
          <button
            className="bouton"
            data-node={id('actions.pause')}
            data-action={recipient.pausedAt ? 'run.reprendre' : 'run.pause'}
            type="button"
            onClick={() => void pause(recipient)}
          >
            {recipient.pausedAt ? 'Reprendre' : 'Pause'}
          </button>
        )}
        <Link
          className="lien pousser"
          data-node={id('actions.ouvrir')}
          data-action="sujet.ouvrir"
          to={`/sujets/${topic.id}`}
        >
          Ouvrir le sujet →
        </Link>
      </div>
      {agrandi && recipient && <Agrandi agent={recipient} onClose={() => setAgrandi(false)} />}
    </article>
  );
}
