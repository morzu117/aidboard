import type { ActionRun, Agent, MeshDm, MeshState, Run, Topic, Workspace } from './model.js';

export interface StateSnapshot {
  lastEventId: string | null;
  workspaces: Workspace[];
  topics: Topic[];
  runs: Run[];
  agents: Agent[];
  actions: ActionRun[];
  /** chantier 27 (D129) : `agents.transport` de la config, le transport des agents claude et codex lancés */
  agentTransport?: 'pty' | 'stream';
  /** présent seulement quand `swairm.bin` est configuré (D43) */
  swairm?: { enabled: true };
  /** présent seulement quand `mesh.cell` est configuré (chantier 12) */
  mesh?: {
    state: MeshState;
    inbox: MeshDm[];
    tailscaleManage: boolean;
    /** chantier 25 (D99 bis) : dernière lecture de `monitor status`, null avant la première */
    checkedAt?: string | null;
  };
}
