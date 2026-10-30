// @vitest-environment jsdom
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test } from 'vitest';
import type { PendingRequest } from '../../src/shared/model.js';
import { ConfirmCard, type ConfirmResolution } from '../../web/src/conversation/ConfirmCard.js';
import { json, setup, snapshot } from './helpers.js';

afterEach(cleanup);

/** Chantier 17 (R.5) : la carte de confirmation d'une commande destructive sur un serveur (§11.3). */
const demande: PendingRequest = {
  id: 'req-1',
  kind: 'permission',
  question: 'Bash : sudo systemctl reload nginx',
  options: [
    { label: 'Autoriser', answer: 'yes' },
    { label: 'Refuser', answer: 'no' },
    { label: 'Toujours autoriser sur ce serveur', answer: 'always' },
  ],
  command: 'sudo systemctl reload nginx',
  byRule: true,
  confirm: { server: 'vps-ovh' },
};

const monter = (resolution: ConfirmResolution = null) =>
  setup(
    <ConfirmCard agentId="sa_1" request={demande} resolution={resolution} dataNode="carte" />,
    snapshot(),
  );

test('en attente : serveur, commande telle qu’écrite, trois boutons dans l’ordre de la maquette', () => {
  monter();
  expect(screen.getByText('Confirmation requise · vps-ovh')).toBeTruthy();
  expect(screen.getByText('sudo systemctl reload nginx')).toBeTruthy();
  expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual([
    'Autoriser',
    'Refuser',
    'Toujours autoriser sur ce serveur',
  ]);
});

test('« Toujours autoriser » : POST sur la route de l’agent distant, puis la carte se ferme', async () => {
  const h = monter();
  h.respond.set('POST /api/server-agents/sa_1/answer', json(202, {}));
  await userEvent.click(screen.getByRole('button', { name: 'Toujours autoriser sur ce serveur' }));
  await waitFor(() => expect(screen.getByText('Toujours autorisée sur ce serveur')).toBeTruthy());
  expect(h.calls.filter((c) => c.url === '/api/server-agents/sa_1/answer')).toEqual([
    {
      method: 'POST',
      url: '/api/server-agents/sa_1/answer',
      body: { pendingId: 'req-1', answer: 'always' },
    },
  ]);
  expect(screen.queryAllByRole('button')).toHaveLength(0);
});

test('réponse refusée par le daemon : erreur affichée, boutons toujours là', async () => {
  const h = monter();
  h.respond.set(
    'POST /api/server-agents/sa_1/answer',
    json(409, { error: 'cette demande n’est plus en cours' }),
  );
  await userEvent.click(screen.getByRole('button', { name: 'Autoriser' }));
  await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
  expect(screen.getAllByRole('button')).toHaveLength(3);
});

test('issues lues au fil : autorisée par règle, refusée, close', () => {
  monter({ answer: 'yes', auto: true });
  expect(screen.getByText('Autorisée par une règle du serveur')).toBeTruthy();
  cleanup();
  monter({ answer: 'no' });
  expect(screen.getByText('Refusée')).toBeTruthy();
  cleanup();
  monter({ cancelled: true });
  expect(screen.getByText('Demande close')).toBeTruthy();
  expect(screen.queryAllByRole('button')).toHaveLength(0);
});
