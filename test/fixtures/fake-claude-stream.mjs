#!/usr/bin/env node
/* global process */
// Faux `claude --print --input-format stream-json ...` : rejoue des événements de la même forme que les
// captures réelles (docs/chantiers/15-…, « Protocoles observés »). Remplace claude dans les tests.
import { Buffer } from 'node:buffer';
import { createInterface } from 'node:readline';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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

// Chantier 19 (S.5) : FAKE_CLAUDE_STRICT=1 fait comme le vrai claude — la session existe dès le premier message
// (même si le tour n'aboutit pas) ; `--session-id` d'une session existante et `--resume` d'une inconnue sont refusés.
const sessions = join(process.env.HOME ?? '.', '.fake-claude-sessions');
const sessionFile = sessionId ? join(sessions, sessionId) : null;
if (process.env.FAKE_CLAUDE_REFUSE) {
  process.stderr.write('Error: refusé (FAKE_CLAUDE_REFUSE)\n');
  process.exit(1);
}
if (process.env.FAKE_CLAUDE_STRICT && sessionFile) {
  if (!resume && existsSync(sessionFile)) {
    process.stderr.write(`Error: Session ID ${sessionId} is already in use.\n`);
    process.exit(1);
  }
  if (resume && !existsSync(sessionFile)) {
    process.stderr.write(`No conversation found with session ID: ${sessionId}\n`);
    process.exit(1);
  }
}

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
  if (process.env.FAKE_CLAUDE_STRICT && sessionFile) {
    mkdirSync(sessions, { recursive: true });
    writeFileSync(sessionFile, '');
  }
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

  // Chantier 17 (R.5) : une commande Bash. Comme claude 2.1.308 (D77) : une règle `ask` de `--settings` force la
  // demande quel que soit le mode, et la demande porte `decision_reason_type: "rule"` ; sans règle, seul le mode
  // `default` demande.
  // plusieurs commandes lancées en parallèle (`commandes: a ;; b`) : toutes les demandes partent avant la
  // première réponse, comme des outils parallèles
  if (text.startsWith('commandes: ')) {
    const answers = await Promise.all(
      text
        .slice('commandes: '.length)
        .split(' ;; ')
        .map((command) => {
          const requestId = `req-${++reqCounter}`;
          emit({
            type: 'control_request',
            request_id: requestId,
            request: {
              subtype: 'can_use_tool',
              tool_name: 'Bash',
              input: { command },
              decision_reason_type: 'rule',
              decision_reason_rule_source: 'flagSettings',
            },
          });
          return new Promise((resolve) => pendingControl.set(requestId, resolve)).then(
            (r) => `${r.behavior === 'allow' ? 'exécutée' : 'refusée'}: ${command}`,
          );
        }),
    );
    for (const t of answers)
      emit({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: t }] },
      });
    emit({ type: 'result', subtype: 'success', session_id: sessionId });
    return;
  }

  if (text.startsWith('commande: ')) {
    const command = text.slice('commande: '.length);
    const rules = (JSON.parse(argAfter('--settings') ?? '{}').permissions?.ask ?? [])
      .map((r) => /^Bash\((.+):\*\)$/.exec(r)?.[1])
      .filter(Boolean);
    const byRule = command
      .split(/&&|\|\||;|\|/)
      .map((c) => c.trim())
      .some((c) => rules.some((p) => c === p || c.startsWith(`${p} `)));
    const say = (t) =>
      emit({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: t }] },
      });
    if (byRule || settings.mode === 'default') {
      const requestId = `req-${++reqCounter}`;
      emit({
        type: 'control_request',
        request_id: requestId,
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Bash',
          display_name: 'Bash',
          input: { command, description: 'commande demandée' },
          tool_use_id: `tool-${reqCounter}`,
          ...(byRule && {
            decision_reason_type: 'rule',
            decision_reason_rule_source: 'flagSettings',
          }),
        },
      });
      const response = await new Promise((resolve) => pendingControl.set(requestId, resolve));
      say(`${response.behavior === 'allow' ? 'exécutée' : 'refusée'}: ${command}`);
    } else {
      say(`exécutée sans demande: ${command}`);
    }
    emit({ type: 'result', subtype: 'success', session_id: sessionId });
    return;
  }

  // AskUserQuestion : claude le fait passer par `can_use_tool` ; la réponse revient dans `updatedInput.answers`.
  if (text === 'demande questions') {
    const requestId = `req-${++reqCounter}`;
    const input = {
      questions: [
        {
          question: 'Où écrire le graphe ?',
          header: 'Graphe',
          options: [{ label: 'YAML' }, { label: 'JSON' }],
        },
        {
          question: 'Quel moteur ?',
          header: 'Moteur',
          options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
        },
      ],
    };
    const response = new Promise((resolve) => pendingControl.set(requestId, resolve));
    emit({
      type: 'control_request',
      request_id: requestId,
      request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input },
    });
    const answered = await response;
    const texte =
      answered.behavior === 'allow'
        ? `réponses ${JSON.stringify(answered.updatedInput.answers)}`
        : `refusé ${answered.message}`;
    emit({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: texte }] },
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
