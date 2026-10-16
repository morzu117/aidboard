import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';
import { ulid } from 'ulid';
import type { EventType } from '../../shared/events.js';
import type { PendingRequest } from '../../shared/model.js';
import { type EmitEnv, emitEvent } from './emit.js';

type Payload = Record<string, unknown>;
export interface Emission {
  type: EventType;
  data: Record<string, unknown>;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const firstLine = (v: unknown, max: number) => str(v).trim().split('\n')[0]!.slice(0, max);

/** « Bash(npm test) » : l'outil et l'argument qui le dit le mieux, borné. */
export function toolLabel(tool: unknown, input: unknown): string {
  const name = str(tool) || 'outil';
  const i = (input && typeof input === 'object' ? input : {}) as Payload;
  const arg =
    name === 'Bash'
      ? i.command
      : ['Edit', 'MultiEdit', 'Write', 'Read'].includes(name)
        ? i.file_path
        : name === 'NotebookEdit'
          ? i.notebook_path
          : ['Grep', 'Glob'].includes(name)
            ? i.pattern
            : name === 'WebFetch'
              ? i.url
              : name === 'Task'
                ? i.description
                : '';
  const summary = firstLine(arg, 120);
  return summary ? `${name}(${summary})` : name;
}

// « Toujours pour npm test » quand Claude Code propose une règle, sinon un libellé neutre
function alwaysLabel(suggestions: unknown): string | null {
  if (!Array.isArray(suggestions) || suggestions.length === 0) return null;
  for (const s of suggestions) {
    const rules = (s as Payload)?.rules;
    const content = Array.isArray(rules) ? str((rules[0] as Payload)?.ruleContent) : '';
    if (content) return `Toujours pour ${content.replace(/:\*$/, '').slice(0, 80)}`;
  }
  return 'Toujours autoriser';
}

function question(p: Payload): PendingRequest {
  const input = (p.tool_input ?? {}) as Payload;
  const qs = Array.isArray(input.questions) ? (input.questions as Payload[]) : [];
  const q = qs[0] ?? {};
  const options = Array.isArray(q.options) ? (q.options as Payload[]) : [];
  // plusieurs questions, ou plusieurs réponses possibles : pas de boutons, on renvoie au terminal
  const simple = qs.length === 1 && q.multiSelect !== true && options.length <= 9;
  return {
    id: str(p.tool_use_id) || ulid(),
    kind: 'question',
    question: firstLine(q.question, 500) || 'Claude pose une question',
    options: simple
      ? options.map((o, i) => ({
          label: firstLine(o.label, 120),
          answer: String(i + 1) as PendingRequest['options'][number]['answer'],
        }))
      : [],
  };
}

/** Table E2 du plan 06 : un événement de hook Claude Code → les événements A-I-D qu'il donne. */
export function mapHook(event: string, p: Payload): Emission[] {
  const status = (s: string, extra: Payload = {}): Emission => ({
    type: 'agent.status',
    data: { status: s, ...extra },
  });
  switch (event) {
    case 'UserPromptSubmit':
    case 'PostToolUse':
      return [status('working')];
    case 'PreToolUse': {
      if (p.tool_name === 'AskUserQuestion') {
        const pending = question(p);
        return [status('needs_input', { reason: 'question', message: pending.question, pending })];
      }
      return [
        { type: 'agent.tool', data: { label: toolLabel(p.tool_name, p.tool_input) } },
        status('working'),
      ];
    }
    case 'PermissionRequest': {
      if (p.tool_name === 'AskUserQuestion') return [];
      const ask = `autoriser ${toolLabel(p.tool_name, p.tool_input)} ?`;
      const always = alwaysLabel(p.permission_suggestions);
      const pending: PendingRequest = {
        id: str(p.tool_use_id) || ulid(),
        kind: 'permission',
        question: ask,
        options: [
          { label: 'Autoriser une fois', answer: 'yes' },
          ...(always ? [{ label: always, answer: 'always' as const }] : []),
          { label: 'Refuser', answer: 'no' },
        ],
      };
      return [status('needs_input', { reason: 'permission', message: ask, pending })];
    }
    case 'Notification':
      // permission_prompt arrive après PermissionRequest et n'en sait pas plus : on ne garde que les dialogues
      if (p.notification_type !== 'elicitation_dialog') return [];
      return [
        status('needs_input', {
          reason: 'question',
          message: firstLine(p.message, 500) || 'Claude attend une réponse',
        }),
      ];
    case 'Stop':
      return [status('idle', { message: firstLine(p.last_assistant_message, 200) || undefined })];
    default:
      return [];
  }
}

/** La lignée du hook, du parent au plus lointain : `{pid, comm}`. Sans `ps`, rien (le daemon ne tranche pas). */
export function processChain(
  start = process.ppid,
  max = 8,
): Array<{ pid: number; comm: string }> | undefined {
  let table: Map<number, { ppid: number; comm: string }>;
  try {
    const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,comm='], {
      encoding: 'utf8',
      timeout: 500,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    table = new Map();
    for (const line of out.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (m) table.set(Number(m[1]), { ppid: Number(m[2]), comm: basename(m[3]!.trim()) });
    }
  } catch {
    return undefined;
  }
  const chain: Array<{ pid: number; comm: string }> = [];
  for (let pid = start; pid > 1 && chain.length < max;) {
    const row = table.get(pid);
    if (!row) break;
    chain.push({ pid, comm: row.comm });
    pid = row.ppid;
  }
  return chain;
}

async function readStdin(limit = 64 * 1024, timeoutMs = 1000): Promise<string> {
  if (process.stdin.isTTY) return '';
  return new Promise((resolve) => {
    let buf = '';
    const done = () => {
      clearTimeout(timer);
      process.stdin.removeAllListeners();
      process.stdin.pause();
      resolve(buf);
    };
    const timer = setTimeout(done, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c: string) => {
      buf += c;
      if (buf.length >= limit) done();
    });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}

/** `aid hook <Événement>` : silencieux, toujours en 0 (un code 2 bloquerait l'outil dans Claude Code). */
export async function runHook(event: string, env: EmitEnv = process.env): Promise<number> {
  try {
    if (!env.AID_AGENT) return 0;
    let payload: Payload = {};
    try {
      const parsed: unknown = JSON.parse((await readStdin()) || '{}');
      if (parsed && typeof parsed === 'object') payload = parsed as Payload;
    } catch {
      payload = {};
    }
    const emissions = mapHook(event, payload);
    if (emissions.length === 0) return 0;
    const chain = processChain();
    for (const e of emissions) {
      const data =
        e.type === 'agent.status'
          ? { ...e.data, chain, sessionId: str(payload.session_id) || undefined }
          : e.data;
      await emitEvent(e.type, data, env, { source: 'hook:claude', timeoutMs: 1500 });
    }
  } catch {
    // jamais d'erreur visible dans la session claude
  }
  return 0;
}
