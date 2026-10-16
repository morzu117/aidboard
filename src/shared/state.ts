import type { ActionRun, Agent, Run, Topic, Workspace } from './model.js';

export interface StateSnapshot {
  lastEventId: string | null;
  workspaces: Workspace[];
  topics: Topic[];
  runs: Run[];
  agents: Agent[];
  actions: ActionRun[];
}
