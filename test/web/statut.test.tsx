// @vitest-environment jsdom
import { expect, test } from 'vitest';
import { agentView, isResumable } from '../../web/src/ui/Statut.js';
import { agent } from './helpers.js';

test('isResumable (A.6) : vrai pour un agent stream claude/codex, faux pour pty ou un autre kind', () => {
  expect(isResumable(agent({ kind: 'claude', transport: 'stream' }))).toBe(true);
  expect(isResumable(agent({ kind: 'codex', transport: 'stream' }))).toBe(true);
  expect(isResumable(agent({ kind: 'claude', transport: 'pty' }))).toBe(false);
  expect(isResumable(agent({ kind: 'shell', transport: 'stream' }))).toBe(false);
});

test('agentView (A.6) : stream done/stopped → « En veille » ; pty inchangé', () => {
  expect(agentView(agent({ kind: 'claude', transport: 'stream', status: 'done' }))).toMatchObject({
    label: 'En veille',
    tone: 'inactif',
  });
  expect(
    agentView(agent({ kind: 'claude', transport: 'stream', status: 'stopped' })),
  ).toMatchObject({ label: 'En veille', tone: 'inactif' });
  expect(agentView(agent({ kind: 'claude', transport: 'pty', status: 'done' }))).toMatchObject({
    label: 'Terminé',
    tone: 'inactif',
  });
  expect(agentView(agent({ kind: 'claude', transport: 'pty', status: 'stopped' }))).toMatchObject({
    label: 'Arrêté',
    tone: 'inactif',
  });
});

test('agentView (A.6) : stream error reste « Erreur », pas « En veille »', () => {
  expect(agentView(agent({ kind: 'claude', transport: 'stream', status: 'error' }))).toMatchObject({
    label: 'Erreur',
    tone: 'erreur',
  });
});
