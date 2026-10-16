import type { AgentStatus } from '../../../src/shared/model.js';

export interface StatusView {
  label: string;
  tone: 'attente' | 'erreur' | 'relire' | 'cours' | 'pause' | 'inactif';
}

// v0.1 : les statuts fins n'arrivent qu'en v0.2. Un agent vivant est « lancé, statut non suivi » :
// afficher « En cours » pour un agent qui attend peut-être une permission serait un repli silencieux.
export function statusView(status: AgentStatus): StatusView {
  switch (status) {
    case 'needs_input':
      return { label: 'Attend une réponse', tone: 'attente' };
    case 'error':
      return { label: 'Erreur', tone: 'erreur' };
    case 'idle':
      return { label: 'À relire', tone: 'relire' };
    case 'working':
      return { label: 'En cours', tone: 'cours' };
    case 'starting':
      return { label: 'Lancé · statut non suivi', tone: 'pause' };
    case 'done':
      return { label: 'Terminé', tone: 'inactif' };
    case 'stopped':
      return { label: 'Arrêté', tone: 'inactif' };
  }
}

// Le plus urgent d'abord : erreur, puis ce qui tourne sans être suivi, puis arrêté, puis terminé.
const URGENCE: AgentStatus[] = [
  'needs_input',
  'error',
  'idle',
  'working',
  'starting',
  'stopped',
  'done',
];

export function aggregateStatus(statuses: AgentStatus[]): AgentStatus | null {
  for (const s of URGENCE) if (statuses.includes(s)) return s;
  return null;
}

export function Point({
  tone,
  label,
  grand,
}: {
  tone: StatusView['tone'];
  label?: string;
  grand?: boolean;
}) {
  return (
    <span
      className={`point point--${tone}${grand ? ' point--grand' : ''}`}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    />
  );
}

export function Badge({ view, dataNode }: { view: StatusView; dataNode?: string }) {
  return (
    <span
      className={`badge badge--${view.tone === 'inactif' ? 'pause' : view.tone}`}
      data-node={dataNode}
      data-bind="sujet.statut"
    >
      {view.label}
    </span>
  );
}
