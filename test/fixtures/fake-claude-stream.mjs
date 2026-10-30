#!/usr/bin/env node
/* global process */
// Faux `claude --print --input-format stream-json ...` : rejoue des événements de la même forme que les
// captures réelles (docs/chantiers/15-…, « Protocoles observés »). Remplace claude dans les tests.
import { Buffer } from 'node:buffer';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const argAfter = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const resume = args.includes('--resume');
const sessionId = resume ? argAfter('--resume') : argAfter('--session-id');
// Réglages (chantier 16) : ceux du lancement, puis ceux des `control_request` reçus ; « reglages » les renvoie.
const settings = {
  mode: argAfter('--permission-mode') ?? 'default',
  model: argAfter('--model') ?? null,
  effort: argAfter('--effort') ?? null,
};

const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

// Ligne reconnaissable pour que le test vérifie les arguments reçus (--session-id / --resume).
emit({
  type: 'system',
  subtype: 'fake_args',
  args,
  mode: resume ? 'resume' : 'new',
  session_id: sessionId,
});

let reqCounter = 0;
const pendingControl = new Map();
let longAbort = null;

async function handleTurn(text) {
  if (text === 'crash') {
    process.kill(process.pid, 'SIGKILL');
    return;
  }
  if (text === 'reglages') text = `reglages ${JSON.stringify(settings)}`;

  emit({ type: 'system', subtype: 'init', session_id: sessionId, cwd: process.cwd() });

  if (text === 'tour long') {
    emit({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'tour long démarré' }] },
    });
    await new Promise((resolve) => {
      longAbort = resolve;
    });
    longAbort = null;
    emit({ type: 'result', subtype: 'error_during_execution', session_id: sessionId });
    return;
  }

  if (text === 'demande permission') {
    const requestId = `req-${++reqCounter}`;
    const toolUseId = `tool-${reqCounter}`;
    emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking' }] } });
    emit({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: { command: 'echo hi' } }],
      },
    });
    emit({
      type: 'control_request',
      request_id: requestId,
      request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'echo hi' } },
    });
    const response = await new Promise((resolve) => pendingControl.set(requestId, resolve));
    if (response.behavior === 'allow') {
      emit({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: toolUseId, content: 'hi', is_error: false },
          ],
        },
      });
      emit({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'fait' }] },
      });
    } else {
      emit({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: toolUseId,
              content: response.message ?? 'refusé',
              is_error: true,
            },
          ],
        },
      });
      emit({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'refusé' }] },
      });
    }
    emit({
      type: 'result',
      subtype: 'success',
      session_id: sessionId,
      total_cost_usd: 0.001,
      duration_ms: 10,
    });
    return;
  }

  // Deux outils dans la même réponse (Read puis Bash) : claude envoie les deux can_use_tool sans attendre.
  if (text === 'deux permissions') {
    const tools = [
      { name: 'Read', input: { file_path: '/tmp/x' } },
      { name: 'Bash', input: { command: 'echo hi' } },
    ].map((t) => ({ ...t, requestId: `req-${++reqCounter}`, toolUseId: `tool-${reqCounter}` }));
    const responses = tools.map((t) => {
      emit({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: t.toolUseId, name: t.name, input: t.input }],
        },
      });
      const response = new Promise((resolve) => pendingControl.set(t.requestId, resolve));
      emit({
        type: 'control_request',
        request_id: t.requestId,
        request: { subtype: 'can_use_tool', tool_name: t.name, input: t.input },
      });
      return response;
    });
    const answered = await Promise.all(responses);
    tools.forEach((t, i) =>
      emit({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: t.toolUseId,
              content: answered[i].behavior === 'allow' ? 'ok' : 'refusé',
              is_error: answered[i].behavior !== 'allow',
            },
          ],
        },
      }),
    );
    emit({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'les deux faits' }] },
    });
    emit({
      type: 'result',
      subtype: 'success',
      session_id: sessionId,
      total_cost_usd: 0.001,
      duration_ms: 10,
    });
    return;
  }

  emit({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: `echo: ${text}` }] },
  });
  emit({
    type: 'result',
    subtype: 'success',
    session_id: sessionId,
    total_cost_usd: 0.001,
    duration_ms: 5,
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
  if (msg.type === 'control_response') {
    const resolve = pendingControl.get(msg.response?.request_id);
    if (resolve) {
      pendingControl.delete(msg.response.request_id);
      resolve(msg.response.response);
    }
    return;
  }
  const reglage = msg.type === 'control_request' ? msg.request : undefined;
  if (['set_permission_mode', 'set_model', 'apply_flag_settings'].includes(reglage?.subtype)) {
    if (reglage.subtype === 'set_permission_mode') settings.mode = reglage.mode;
    if (reglage.subtype === 'set_model') settings.model = reglage.model ?? null;
    if (reglage.subtype === 'apply_flag_settings')
      settings.effort = reglage.settings?.effortLevel ?? null;
    emit({
      type: 'control_response',
      response: { subtype: 'success', request_id: msg.request_id },
    });
    return;
  }
  if (msg.type === 'control_request' && msg.request?.subtype === 'interrupt') {
    emit({
      type: 'control_response',
      response: { subtype: 'success', request_id: msg.request_id, response: { still_queued: [] } },
    });
    if (longAbort) longAbort();
    return;
  }
  // chantier 16 (D70) : un message avec pièces jointes arrive en blocs ; l'écho résume les images reçues.
  if (msg.type === 'user' && Array.isArray(msg.message.content)) {
    const blocs = msg.message.content;
    const texte = blocs
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const images = blocs
      .filter((b) => b.type === 'image')
      .map((b) => `${b.source.media_type}:${Buffer.from(b.source.data, 'base64').length}`);
    void handleTurn(`${texte} [images: ${images.join(',')}]`);
    return;
  }
  if (msg.type === 'user') {
    void handleTurn(msg.message.content);
  }
});
rl.on('close', () => process.exit(0));
