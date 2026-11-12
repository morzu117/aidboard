import { expect, test } from 'vitest';
import { parseClaudeTranscript } from '../src/daemon/remote/claudeSessions.js';

const entry = (type: string, content: unknown, extra = {}) =>
  JSON.stringify({ type, cwd: '/srv/projet', message: { role: type, content }, ...extra });

test('transcription : texte seul, lignes invalides, métadonnées et commandes ignorées', () => {
  const parsed = parseClaudeTranscript(
    [
      'invalide',
      'null',
      '{}',
      entry('user', [{ type: 'tool_result', content: 'secret' }]),
      entry('user', '<command-name>/help</command-name>'),
      entry('user', 'side', { isSidechain: true }),
      entry('assistant', 'meta', { isMeta: true }),
      entry('user', 'Bonjour'),
      entry('assistant', [
        { type: 'text', text: 'Réponse' },
        { type: 'tool_use', name: 'bash' },
      ]),
      entry('unknown', 'inconnu'),
      '{"type":',
    ].join('\n'),
  );
  expect(parsed.cwd).toBe('/srv/projet');
  expect(parsed.messages).toEqual([
    { type: 'message', role: 'user', text: 'Bonjour' },
    { type: 'message', role: 'assistant', text: 'Réponse' },
  ]);
});
