#!/usr/bin/env node
/* global process */
// Faux `codex app-server` : rejoue le JSON-RPC observé (docs/chantiers/15-…, « Protocoles observés »).
// Remplace codex dans les tests.
import { createInterface } from 'node:readline';

const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

// Ligne reconnaissable pour que le test vérifie les arguments reçus (`app-server` + extraArgs).
emit({ type: 'fake_args', args: process.argv.slice(2) });

let threadId = null;
let turnCounter = 0;
let approvalCounter = 0;
const pendingApprovalResolvers = new Map();
const pendingUnknownResolvers = new Map();
let longAbort = null;

function makeTurnId() {
  return `turn-${++turnCounter}`;
}

async function runTurn(reqId, turnThreadId, text) {
  const turnId = makeTurnId();
  emit({ id: reqId, result: { turn: { id: turnId, status: 'inProgress' } } });

  if (text === 'tour long') {
    await new Promise((resolve) => {
      longAbort = { resolve };
    });
    longAbort = null;
    emit({
      method: 'turn/completed',
      params: {
        threadId: turnThreadId,
        turn: { id: turnId, status: 'interrupted', durationMs: 1 },
      },
    });
    return;
  }

  if (text === 'demande permission') {
    const approvalId = approvalCounter++;
    const itemId = `exec-${approvalId}`;
    emit({
      method: 'item/started',
      params: {
        item: { type: 'commandExecution', id: itemId, command: 'echo hi', status: 'inProgress' },
        threadId: turnThreadId,
        turnId,
      },
    });
    emit({
      id: approvalId,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: turnThreadId, turnId, itemId, command: 'echo hi', cwd: process.cwd() },
    });
    const decision = await new Promise((resolve) =>
      pendingApprovalResolvers.set(approvalId, resolve),
    );
    let text2;
    let status;
    let aggregatedOutput = null;
    let exitCode = null;
    if (decision === 'accept') {
      text2 = 'fait';
      status = 'completed';
      aggregatedOutput = 'hi';
      exitCode = 0;
    } else if (decision === 'acceptForSession') {
      text2 = 'fait toujours';
      status = 'completed';
      aggregatedOutput = 'hi';
      exitCode = 0;
    } else {
      text2 = 'refusé';
      status = 'declined';
    }
    emit({
      method: 'item/completed',
      params: {
        item: {
          type: 'commandExecution',
          id: itemId,
          command: 'echo hi',
          status,
          aggregatedOutput,
          exitCode,
        },
        threadId: turnThreadId,
        turnId,
      },
    });
    emit({
      method: 'item/completed',
      params: {
        item: { type: 'agentMessage', id: `msg-${turnId}`, text: text2, phase: 'final_answer' },
        threadId: turnThreadId,
        turnId,
      },
    });
    emit({
      method: 'turn/completed',
      params: { threadId: turnThreadId, turn: { id: turnId, status: 'completed', durationMs: 5 } },
    });
    return;
  }

  if (text === 'requete inconnue') {
    const unkId = `unk-${turnId}`;
    emit({ id: unkId, method: 'methode/inconnue', params: {} });
    const response = await new Promise((resolve) => pendingUnknownResolvers.set(unkId, resolve));
    const text2 = response?.error ? 'erreur recue' : 'pas derreur';
    emit({
      method: 'item/completed',
      params: {
        item: { type: 'agentMessage', id: `msg-${turnId}`, text: text2, phase: 'final_answer' },
        threadId: turnThreadId,
        turnId,
      },
    });
    emit({
      method: 'turn/completed',
      params: { threadId: turnThreadId, turn: { id: turnId, status: 'completed', durationMs: 5 } },
    });
    return;
  }

  emit({
    method: 'item/completed',
    params: {
      item: {
        type: 'agentMessage',
        id: `msg-${turnId}`,
        text: `echo: ${text}`,
        phase: 'final_answer',
      },
      threadId: turnThreadId,
      turnId,
    },
  });
  emit({
    method: 'turn/completed',
    params: { threadId: turnThreadId, turn: { id: turnId, status: 'completed', durationMs: 5 } },
  });
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  if (msg.method === 'initialized') return;

  if (msg.method === 'initialize') {
    emit({
      id: msg.id,
      result: {
        userAgent: 'fake-codex/0.0.0',
        codexHome: '/tmp/fake-codex-home',
        platformFamily: 'unix',
        platformOs: 'macos',
      },
    });
    return;
  }

  if (msg.method === 'thread/start') {
    threadId = 'thread-new-fixed';
    emit({ id: msg.id, result: { thread: { id: threadId } } });
    return;
  }

  if (msg.method === 'thread/resume') {
    threadId = msg.params.threadId;
    emit({ id: msg.id, result: { thread: { id: threadId } } });
    return;
  }

  if (msg.method === 'turn/start') {
    const text = msg.params?.input?.[0]?.text;
    if (text === 'crash') {
      process.kill(process.pid, 'SIGKILL');
      return;
    }
    void runTurn(msg.id, msg.params.threadId, text);
    return;
  }

  if (msg.method === 'turn/interrupt') {
    emit({ id: msg.id, result: {} });
    if (longAbort) longAbort.resolve();
    return;
  }

  // réponse du client à une requête serveur→client (approbation ou méthode inconnue).
  if (msg.id !== undefined && msg.method === undefined) {
    if (pendingApprovalResolvers.has(msg.id)) {
      const resolve = pendingApprovalResolvers.get(msg.id);
      pendingApprovalResolvers.delete(msg.id);
      resolve(msg.result?.decision);
      return;
    }
    if (pendingUnknownResolvers.has(msg.id)) {
      const resolve = pendingUnknownResolvers.get(msg.id);
      pendingUnknownResolvers.delete(msg.id);
      resolve(msg);
      return;
    }
  }
});
rl.on('close', () => process.exit(0));
