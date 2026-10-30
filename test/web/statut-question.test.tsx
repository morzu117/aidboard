import { expect, test } from 'vitest';
import { agentView, mostUrgent, topicView } from '../../web/src/ui/Statut.js';
import { agent } from './helpers.js';

const idle = (over = {}) => agent({ kind: 'claude', transport: 'stream', status: 'idle', ...over });

test('un tour fini sur une question se lit « Attend une réponse », en attente', () => {
  const a = idle({ statusReason: 'question' });
  expect(agentView(a)).toEqual({ label: 'Attend une réponse', tone: 'attente' });
  expect(agentView(a, 'boite')).toEqual({ label: 'Attend une réponse', tone: 'attente' });
});

test('un tour fini sans question reste « À relire »', () => {
  expect(agentView(idle()).tone).toBe('relire');
  expect(agentView(idle({ statusReason: null })).label).toBe('À relire');
});

test('la pause l’emporte, et la question passe devant un autre agent à relire', () => {
  expect(agentView(idle({ statusReason: 'question', pausedAt: 't' })).tone).toBe('pause');
  const aRelire = idle({ id: 'a' });
  const question = idle({ id: 'b', statusReason: 'question' });
  expect(mostUrgent([aRelire, question])?.id).toBe('b');
  expect(topicView([aRelire, question]).label).toBe('Attend une réponse');
});
