import { useId, useState } from 'react';
import type { Agent } from '../../../src/shared/model.js';

export type Tone = 'attente' | 'erreur' | 'relire' | 'cours' | 'pause' | 'inactif';

export interface StatusView {
  label: string;
  tone: Tone;
  /** statut déduit du terminal par l'heuristique, sans signal sûr */
  estimated?: boolean;
}

const ENDED = new Set<Agent['status']>(['done', 'error', 'stopped']);
export const isAlive = (a: Agent) => !ENDED.has(a.status);

/** Reprise transparente (A.6) : un agent qui peut repartir sous le même id au prochain message. */
export const isResumable = (a: Agent): boolean =>
  a.transport === 'stream' && (a.kind === 'claude' || a.kind === 'codex');

/**
 * Le statut affiché d'un agent. La pause l'emporte sur le statut (E5) ; un shell vivant n'a pas de
 * statut suivi et s'affiche « shell » en gris ; `idle` se lit « À relire » sur une carte et « Tour
 * terminé » dans la boîte de réception, ou « Inactif » quand l'heuristique en est la source.
 */
export function agentView(a: Agent, where: 'carte' | 'boite' = 'carte'): StatusView {
  const alive = isAlive(a);
  if (alive && a.pausedAt) return { label: 'En pause', tone: 'pause' };
  if (alive && a.kind === 'shell') return { label: 'shell', tone: 'inactif' };
  const estimated = a.statusSource === 'heuristic' || undefined;
  switch (a.status) {
    case 'needs_input':
      return { label: 'Attend une réponse', tone: 'attente', estimated };
    case 'error':
      return { label: 'Erreur', tone: 'erreur' };
    case 'idle':
      if (where === 'carte') return { label: 'À relire', tone: 'relire', estimated };
      return estimated
        ? { label: 'Inactif', tone: 'relire', estimated }
        : { label: 'Tour terminé', tone: 'relire' };
    case 'working':
      return { label: 'En cours', tone: 'cours', estimated };
    case 'starting':
      return { label: 'Démarrage', tone: 'cours' };
    case 'done':
      return isResumable(a)
        ? { label: 'En veille', tone: 'inactif' }
        : { label: 'Terminé', tone: 'inactif' };
    case 'stopped':
      return isResumable(a)
        ? { label: 'En veille', tone: 'inactif' }
        : { label: 'Arrêté', tone: 'inactif' };
  }
}

// Le plus urgent d'abord ; à urgence égale, l'ordre des agents.
const URGENCE: Tone[] = ['attente', 'erreur', 'relire', 'cours', 'pause', 'inactif'];
const rank = (a: Agent) => URGENCE.indexOf(agentView(a).tone);

/** L'agent qui donne son statut à la carte et reçoit les messages par défaut. Un shell ne compte que seul. */
export function mostUrgent(agents: Agent[]): Agent | undefined {
  const others = agents.filter((a) => a.kind !== 'shell');
  const pool = others.length > 0 ? others : agents;
  return pool.reduce<Agent | undefined>(
    (best, a) => (!best || rank(a) < rank(best) ? a : best),
    undefined,
  );
}

export function topicView(agents: Agent[]): StatusView {
  const a = mostUrgent(agents);
  return a ? agentView(a) : { label: 'Aucun agent', tone: 'inactif' };
}

/** Les shells encore vivants d'un sujet : ils tournent en arrière-plan, sans statut suivi. */
export const shellsVivants = (agents: Agent[]): number =>
  agents.filter((a) => a.kind === 'shell' && isAlive(a)).length;

/**
 * Icône « shells en arrière-plan », pour un sujet qui n'affiche plus rien (point gris : en veille,
 * arrêté, aucun agent, ou rien d'autre qu'un shell) alors que des shells tournent encore. Dès qu'un
 * agent a un statut à montrer, c'est le point qui parle et l'icône disparaît.
 */
export function ShellsEnArriere({ agents, dataNode }: { agents: Agent[]; dataNode?: string }) {
  const n = shellsVivants(agents);
  if (n === 0 || topicView(agents).tone !== 'inactif') return null;
  const label = `${n} shell${n > 1 ? 's' : ''} en arrière-plan`;
  return (
    <span
      className="shells-arriere"
      role="img"
      aria-label={label}
      title={label}
      data-node={dataNode}
    >
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <path
          d="M3 5l4 3-4 3M8.5 12H13"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {n > 1 && <span>{n}</span>}
    </span>
  );
}

export function Point({
  tone,
  label,
  grand,
  estimated,
  dataNode,
}: {
  tone: Tone;
  label?: string;
  grand?: boolean;
  estimated?: boolean;
  dataNode?: string;
}) {
  return (
    <span
      className={`point point--${tone}${estimated ? ' point--estime' : ''}${grand ? ' point--grand' : ''}`}
      data-node={dataNode}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    />
  );
}

const duree = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.round(s / 60)} min`;
};

/** Pourquoi le statut est estimé : la source, le silence, la dernière ligne et l'invite vues par l'heuristique. */
function Infobulle({ id, agent, dataNode }: { id: string; agent: Agent; dataNode: string }) {
  const d = agent.statusDetail ?? {};
  const n = (rest: string) => `${dataNode}.${rest}`;
  return (
    <div className="infobulle" id={id} data-node={dataNode} data-layer="overlay" role="tooltip">
      <p className="infobulle-titre" data-node={n('titre')}>
        Statut estimé
      </p>
      <ul className="infobulle-liste">
        <li className="infobulle-element" data-node={n('source')} data-bind="agent.source">
          Source : heuristique, aucun hook reçu de {agent.kind}
        </li>
        {d.silenceMs !== undefined && (
          <li
            className="infobulle-element"
            data-node={n('silence')}
            data-bind="agent.silence_depuis"
          >
            Terminal silencieux depuis {duree(d.silenceMs)}
          </li>
        )}
        {d.lastLine && (
          <li
            className="infobulle-element"
            data-node={n('derniere-ligne')}
            data-bind="terminal.ligne"
          >
            Dernière ligne : « {d.lastLine} »
          </li>
        )}
        <li className="infobulle-element" data-node={n('invite')} data-bind="agent.invite_detectee">
          Motif d’invite détecté : {d.promptDetected ? 'oui' : 'non'}
        </li>
      </ul>
    </div>
  );
}

export function Badge({
  view,
  dataNode,
  agent,
}: {
  view: StatusView;
  dataNode?: string;
  /** l'agent dont vient le statut : son détail remplit l'infobulle d'un statut estimé */
  agent?: Agent;
}) {
  const tipId = useId();
  const [tip, setTip] = useState(false);
  const cls = `badge badge--${view.tone === 'inactif' ? 'pause' : view.tone}`;
  if (!view.estimated || !agent) {
    return (
      <span className={cls} data-node={dataNode} data-bind="sujet.statut">
        {view.label}
      </span>
    );
  }
  const base = dataNode?.replace(/\.statut$/, '') ?? 'statut';
  return (
    <span
      className="ancre-infobulle"
      onMouseEnter={() => setTip(true)}
      onMouseLeave={() => setTip(false)}
      onFocus={() => setTip(true)}
      onBlur={() => setTip(false)}
    >
      <span
        className={`${cls} badge--estime`}
        data-node={dataNode}
        data-bind="sujet.statut"
        tabIndex={0}
        aria-describedby={tip ? tipId : undefined}
      >
        {view.label}{' '}
        <span data-node={`${base}.estime`} data-bind="agent.source">
          · estimé
        </span>
      </span>
      {tip && <Infobulle id={tipId} agent={agent} dataNode={`${base}.infobulle`} />}
    </span>
  );
}
