// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { aggregateStatus, statusView } from '../../web/src/ui/Statut.js';
import { Shell } from '../../web/src/ui/Shell.js';
import { viewportFor } from '../../web/src/ui/useViewport.js';

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

test('un agent vivant est « lancé, statut non suivi », jamais « en cours »', () => {
  expect(statusView('starting')).toEqual({ label: 'Lancé · statut non suivi', tone: 'pause' });
  expect(statusView('error').label).toBe('Erreur');
  expect(statusView('done').label).toBe('Terminé');
  expect(statusView('stopped').label).toBe('Arrêté');
});

test('le statut d’un sujet est celui de son agent le plus urgent', () => {
  expect(aggregateStatus(['done', 'starting', 'error'])).toBe('error');
  expect(aggregateStatus(['done', 'stopped'])).toBe('stopped');
  expect(aggregateStatus(['starting', 'done'])).toBe('starting');
  expect(aggregateStatus([])).toBeNull();
});
