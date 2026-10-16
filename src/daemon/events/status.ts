import type { PendingOption, PendingRequest, StatusDetail } from '../../shared/model.js';

// Ce qu'un agent dit de lui-même passe par ici avant d'entrer dans les tables : tailles bornées, champs connus,
// et jamais de touche à envoyer (le daemon la déduit de `answer`).

export const AGENT_STATUSES = new Set(['working', 'needs_input', 'idle']);
const ANSWERS = new Set(['yes', 'always', 'no', '1', '2', '3', '4', '5', '6', '7', '8', '9']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'ksh', 'env']);

export const clip = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.length > 0 ? v.slice(0, max) : null;

export function sanitizePending(v: unknown): PendingRequest | null {
  if (!v || typeof v !== 'object') return null;
  const p = v as Record<string, unknown>;
  const id = clip(p.id, 64);
  const question = clip(p.question, 500);
  if (!id || !question || (p.kind !== 'permission' && p.kind !== 'question')) return null;
  const options: PendingOption[] = [];
  for (const o of Array.isArray(p.options) ? p.options.slice(0, 9) : []) {
    const label = clip((o as Record<string, unknown>)?.label, 120);
    const answer = (o as Record<string, unknown>)?.answer;
    if (label && typeof answer === 'string' && ANSWERS.has(answer))
      options.push({ label, answer: answer as PendingOption['answer'] });
  }
  return { id, kind: p.kind, question, options };
}

export function sanitizeDetail(v: unknown): StatusDetail | null {
  if (!v || typeof v !== 'object') return null;
  const d = v as Record<string, unknown>;
  const out: StatusDetail = {};
  if (typeof d.silenceMs === 'number' && Number.isFinite(d.silenceMs))
    out.silenceMs = Math.max(0, Math.round(d.silenceMs));
  const line = clip(d.lastLine, 200);
  if (line) out.lastLine = line;
  if (typeof d.promptDetected === 'boolean') out.promptDetected = d.promptDetected;
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Un `claude -p` lancé par l'agent hérite de ses AID_* : ses hooks arrivent sous le même agent. `chain` est la
 * lignée du hook, du plus proche au plus lointain. Si un process autre qu'un shell se trouve entre le hook et
 * l'agent, c'est une sous-session : elle ne change pas le statut. Lignée absente ou agent introuvable : on ne
 * peut pas trancher, l'événement compte.
 */
export function isSubSession(chain: unknown, agentPid: number | null): boolean {
  if (!Array.isArray(chain) || agentPid === null) return false;
  const at = chain.findIndex((p) => (p as { pid?: unknown })?.pid === agentPid);
  if (at < 0) return false;
  return chain.slice(0, at).some((p) => {
    const comm = String((p as { comm?: unknown })?.comm ?? '');
    return !SHELLS.has(comm.split('/').at(-1)!.replace(/^-/, ''));
  });
}
