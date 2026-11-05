import { expect, test } from 'vitest';
import { prochaineChose, sectionDe, tuileProjet } from '../../web/src/ui/rangement.js';
import { agent, topic } from './helpers.js';

// le helper part d'un shell, qui n'a pas de statut suivi
const claude: typeof agent = (over = {}) => agent({ kind: 'claude', transport: 'stream', ...over });

test('D103 : la section vient de l’agent le plus urgent', () => {
  expect(sectionDe([claude({ status: 'needs_input' })])).toBe('a-decider');
  expect(sectionDe([claude({ status: 'idle', statusReason: 'question' })])).toBe('a-decider');
  expect(sectionDe([claude({ status: 'idle' })])).toBe('a-relire');
  expect(sectionDe([claude({ status: 'error' })])).toBe('a-relire');
  expect(sectionDe([claude({ status: 'working' })])).toBe('en-cours');
  expect(sectionDe([claude({ status: 'starting' })])).toBe('en-cours');
  expect(sectionDe([claude({ status: 'working', pausedAt: '2026-11-05T20:00:00Z' })])).toBe(
    'en-pause',
  );
  // une question l'emporte sur un autre agent au travail
  expect(
    sectionDe([claude({ status: 'working' }), claude({ id: 'a2', status: 'needs_input' })]),
  ).toBe('a-decider');
});

test('D103 : sans agent vivant, en pause ; un shell vivant seul, en cours', () => {
  expect(sectionDe([])).toBe('en-pause');
  expect(sectionDe([agent({ kind: 'claude', transport: 'stream', status: 'stopped' })])).toBe(
    'en-pause',
  );
  expect(sectionDe([agent({ kind: 'claude', transport: 'pty', status: 'done' })])).toBe('en-pause');
  expect(sectionDe([agent({ kind: 'shell', status: 'working' })])).toBe('en-cours');
});

test('D108 : la prochaine chose, de la question à la phase', () => {
  const t = topic({ phase: 'review' });
  const question = agent({
    status: 'needs_input',
    statusMessage: 'en attente',
    pending: { id: 'r1', kind: 'question', question: 'Inclure la migration ?', options: [] },
  });
  expect(prochaineChose(t, [question])).toBe('Inclure la migration ?');
  expect(prochaineChose(t, [claude({ status: 'working', statusMessage: 'Lance les tests' })])).toBe(
    'Lance les tests',
  );
  expect(prochaineChose(t, [claude({ status: 'working', statusMessage: null })])).toBe(
    'Phase : Revue',
  );
  expect(
    prochaineChose(topic({ phase: null }), [claude({ status: 'idle', statusMessage: null })]),
  ).toBe('À relire');
  expect(prochaineChose(topic({ phase: null }), [])).toBe('Aucun agent sur ce sujet');
});

test('D105 : la tuile garde sa couleur quand le projet est renommé, et reste dans la palette', () => {
  const a = tuileProjet('ws_abc', 'skifer', 8);
  expect(a.lettre).toBe('S');
  expect(tuileProjet('ws_abc', 'autre nom', 8).couleur).toBe(a.couleur);
  for (const id of ['ws_1', 'ws_2', 'ws_3', 'ws_zz'])
    expect(tuileProjet(id, 'x', 8).couleur).toBeLessThan(8);
  expect(tuileProjet('ws_1', '  ', 8).lettre).toBe('?');
  expect(tuileProjet('ws_1', 'x', 0).couleur).toBe(0);
});
