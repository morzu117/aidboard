import { expect, test } from 'vitest';
import { etapesPhase, etatOnglet } from '../../web/src/ui/sujetVue.js';
import { agent } from './helpers.js';

const claude: typeof agent = (over = {}) => agent({ kind: 'claude', transport: 'stream', ...over });

test('D115 : l’état d’un onglet d’agent, en mots', () => {
  expect(etatOnglet(claude({ status: 'working' }))).toBe('au travail');
  expect(etatOnglet(claude({ status: 'starting' }))).toBe('au travail');
  expect(etatOnglet(claude({ status: 'needs_input' }))).toBe('attend ta réponse');
  expect(etatOnglet(claude({ status: 'idle', statusReason: 'question' }))).toBe(
    'attend ta réponse',
  );
  expect(etatOnglet(claude({ status: 'idle' }))).toBe('libre');
  expect(etatOnglet(claude({ status: 'error' }))).toBe('erreur');
  expect(etatOnglet(claude({ status: 'stopped' }))).toBe('en veille');
  expect(etatOnglet(agent({ kind: 'claude', transport: 'pty', status: 'stopped' }))).toBe('arrêté');
  expect(etatOnglet(claude({ status: 'working', pausedAt: '2026-11-05T20:00:00Z' }))).toBe(
    'en pause',
  );
  expect(etatOnglet(agent({ kind: 'shell', status: 'working' }))).toBe('ouvert');
});

test('D113 : les cinq phases en segments, rien sans phase', () => {
  expect(etapesPhase(null)).toBeNull();
  const e = etapesPhase('dev')!;
  expect(e.ligne).toBe('Phase 2 sur 5 · Développement');
  expect(e.segments.map((s) => s.etat)).toEqual([
    'fait',
    'en-cours',
    'a-venir',
    'a-venir',
    'a-venir',
  ]);
  expect(etapesPhase('retro')!.segments.at(-1)!.etat).toBe('en-cours');
});
