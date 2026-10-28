// @vitest-environment jsdom
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test } from 'vitest';
import { PiedPause } from '../../web/src/terminal/PiedPause.js';
import { agent, json, setup, snapshot } from './helpers.js';

afterEach(cleanup);

const node = (id: string) => document.querySelector(`[data-node="${id}"]`) as HTMLElement | null;

test('agent vivant : bouton Pause, un clic appelle /pause', async () => {
  const h = setup(
    <PiedPause agentId="ag_1" />,
    snapshot({ agents: [agent({ status: 'working' })] }),
  );
  await screen.findByText('Pause');
  await userEvent.click(node('1-3.terminaux.pied.pause')!);
  expect(h.calls.some((c) => c.method === 'POST' && c.url === '/api/agents/ag_1/pause')).toBe(true);
});

test('agent en pause : bouton Reprendre, un clic appelle /resume', async () => {
  const h = setup(
    <PiedPause agentId="ag_1" />,
    snapshot({ agents: [agent({ status: 'working', pausedAt: new Date().toISOString() })] }),
  );
  await screen.findByText('Reprendre');
  await userEvent.click(node('1-3.terminaux.pied.pause')!);
  expect(h.calls.some((c) => c.method === 'POST' && c.url === '/api/agents/ag_1/resume')).toBe(
    true,
  );
});

test('agent terminé : aucun bouton', async () => {
  const h = setup(<PiedPause agentId="ag_1" />, snapshot({ agents: [agent({ status: 'done' })] }));
  await waitFor(() => expect(h.calls.some((c) => c.url === '/api/state')).toBe(true));
  expect(node('1-3.terminaux.pied.pause')).toBeNull();
});

test('échec : message d’erreur discret', async () => {
  const h = setup(
    <PiedPause agentId="ag_1" />,
    snapshot({ agents: [agent({ status: 'working' })] }),
  );
  h.respond.set('POST /api/agents/ag_1/pause', json(409, { error: 'déjà en pause' }));
  await screen.findByText('Pause');
  await userEvent.click(node('1-3.terminaux.pied.pause')!);
  expect((await screen.findByRole('alert')).textContent).toContain('déjà en pause');
});
