import { join } from 'node:path';
import { monotonicFactory } from 'ulid';
import type { EventStore } from '../events/store.js';
import type { AidPaths } from '../paths.js';
import type { WorkspaceQueue } from './queue.js';
import { runScript, type ScriptOutcome } from './runner.js';

const ulid = monotonicFactory();

export interface ActionContext {
  store: EventStore;
  paths: AidPaths;
  queue: WorkspaceQueue;
}

export interface ActionSpec {
  workspaceId: string;
  topicId?: string;
  action: string;
  script: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  data?: Record<string, unknown>;
  // Appelé après un succès du script ; peut écrire des événements et rendre le topicId à joindre.
  afterSuccess?: (out: ScriptOutcome) => { topicId?: string } | void;
}

// Retire les variables à ne pas transmettre, ajoute les AID_* et verrouille git en non interactif.
export function scriptEnv(
  base: NodeJS.ProcessEnv,
  strip: string[],
  aid: Record<string, string>,
): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of strip) delete env[key];
  return {
    ...env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
    ...aid,
  };
}

export function startAction(
  ctx: ActionContext,
  spec: ActionSpec,
): { actionId: string; done: Promise<void> } {
  const actionId = `ac_${ulid()}`;
  const base = { workspaceId: spec.workspaceId, ...(spec.topicId && { topicId: spec.topicId }) };
  ctx.store.append({
    ...base,
    source: 'action',
    type: 'action.started',
    data: { actionId, action: spec.action, ...spec.data },
  });
  const done = ctx.queue.run(spec.workspaceId, async () => {
    const out = await runScript({
      script: spec.script,
      cwd: spec.cwd,
      env: spec.env,
      timeoutMs: spec.timeoutMs,
      logPath: join(ctx.paths.actionLogs, `${actionId}.log`),
      onLine: ({ stream, line }) =>
        ctx.store.emitEphemeral({
          kind: 'ephemeral',
          type: 'action.output',
          actionId,
          ...(spec.topicId && { topicId: spec.topicId }),
          stream,
          line,
        }),
    });
    let topicId = spec.topicId;
    let final = out;
    if (out.outcome === 'succeeded' && spec.afterSuccess) {
      try {
        topicId = spec.afterSuccess(out)?.topicId ?? topicId;
      } catch (err) {
        final = {
          ...out,
          outcome: 'failed',
          tail: [...out.tail, `après-script : ${(err as Error).message}`],
        };
      }
    }
    ctx.store.append({
      workspaceId: spec.workspaceId,
      ...(topicId && { topicId }),
      source: 'action',
      type: 'action.finished',
      data: {
        actionId,
        action: spec.action,
        outcome: final.outcome,
        exitCode: final.exitCode,
        result: final.result,
        tail: final.tail,
        ...(final.reason && { reason: final.reason }),
      },
    });
  });
  return { actionId, done };
}
