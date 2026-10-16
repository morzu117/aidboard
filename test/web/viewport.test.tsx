// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { agentView, mostUrgent, topicView } from '../../web/src/ui/Statut.js';
import { Shell } from '../../web/src/ui/Shell.js';
import { viewportFor } from '../../web/src/ui/useViewport.js';
import { agent } from './helpers.js';

test('viewportFor aux quatre seuils', () => {
  expect([320, 639].map(viewportFor)).toEqual(['phone', 'phone']);
  expect([640, 1179].map(viewportFor)).toEqual(['tablet', 'tablet']);
  expect([1180, 1719].map(viewportFor)).toEqual(['desktop', 'desktop']);
  expect([1720, 3000].map(viewportFor)).toEqual(['wide', 'wide']);
});

test('la coque pose data-viewport et le recalcule au redimensionnement', () => {
  window.innerWidth = 1440;
  render(
    <Shell>
      <p>contenu</p>
    </Shell>,
  );
  const root = screen.getByText('contenu').parentElement!;
  expect(root.getAttribute('data-viewport')).toBe('desktop');
  act(() => {
    window.innerWidth = 390;
    window.dispatchEvent(new Event('resize'));
  });
  expect(root.getAttribute('data-viewport')).toBe('phone');
});

test('statut d’un agent : la pause l’emporte, un shell est « shell », idle selon l’écran', () => {
  expect(agentView(agent({ kind: 'claude', status: 'starting' }))).toEqual({
    label: 'Démarrage',
    tone: 'cours',
  });
  expect(agentView(agent({ kind: 'claude', status: 'working', pausedAt: 't' })).label).toBe(
    'En pause',
  );
  expect(agentView(agent({ kind: 'shell', status: 'working' }))).toEqual({
    label: 'shell',
    tone: 'inactif',
  });
  expect(agentView(agent({ kind: 'shell', status: 'error' })).label).toBe('Erreur');
  const idle = agent({ kind: 'claude', status: 'idle', statusSource: 'hook' });
  expect(agentView(idle).label).toBe('À relire');
  expect(agentView(idle, 'boite').label).toBe('Tour terminé');
  const estime = { ...idle, statusSource: 'heuristic' as const };
  expect(agentView(estime)).toEqual({ label: 'À relire', tone: 'relire', estimated: true });
  expect(agentView(estime, 'boite')).toEqual({ label: 'Inactif', tone: 'relire', estimated: true });
  expect(agentView(agent({ kind: 'claude', status: 'done' })).label).toBe('Terminé');
  expect(agentView(agent({ kind: 'claude', status: 'stopped' })).label).toBe('Arrêté');
});

test('le statut d’un sujet est celui de son agent le plus urgent ; un shell ne compte que seul', () => {
  const shell = agent({ id: 's', kind: 'shell', status: 'working' });
  const err = agent({ id: 'e', kind: 'claude', status: 'error' });
  const ask = agent({ id: 'q', kind: 'codex', status: 'needs_input' });
  const done = agent({ id: 'd', kind: 'claude', status: 'done' });
  expect(mostUrgent([shell, done, err])?.id).toBe('e');
  expect(mostUrgent([err, ask])?.id).toBe('q');
  expect(mostUrgent([shell, done])?.id).toBe('d');
  expect(mostUrgent([shell])?.id).toBe('s');
  expect(topicView([])).toEqual({ label: 'Aucun agent', tone: 'inactif' });
});
