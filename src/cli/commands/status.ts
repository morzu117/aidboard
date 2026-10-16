import type { StateSnapshot } from '../../shared/state.js';
import { daemonFetch, type DaemonInfo } from '../daemonInfo.js';

const LIVE = ['starting', 'working', 'needs_input', 'idle'];

function uptime(since: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(since)) / 1000));
  if (s < 90) return `${s} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  return `${Math.round(s / 3600)} h`;
}

export async function statusLines(info: DaemonInfo | null): Promise<string[]> {
  if (!info) return ['daemon arrêté'];
  const { json } = await daemonFetch(info, 'GET', '/api/state');
  const state = json as unknown as StateSnapshot;
  const live = state.agents.filter((a) => LIVE.includes(a.status)).length;
  return [
    `daemon en marche (pid ${info.pid}, port ${info.port}, depuis ${uptime(info.startedAt)})`,
    `${state.topics.length} sujet(s), ${live} agent(s) vivant(s)`,
  ];
}
