// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { Server } from '../../src/shared/model.js';
import { NouvelleDiscussion } from '../../web/src/dialogues/NouvelleDiscussion.js';
import { Chemin, json, setup, snapshot } from './helpers.js';

afterEach(cleanup);
const server: Server = {
  id: 'srv_1',
  name: 'vps',
  mode: 'ssh_alias',
  target: 'vps',
  sshOptions: null,
  loadProfile: false,
  workdir: '~',
  shell: 'bash',
  keepSession: true,
  permissionMode: 'default',
  confirmDestructive: true,
  allowedDirs: ['~'],
  groupName: 'Serveurs',
  color: '#5de0a1',
  detectedAgents: ['claude', 'codex'],
  lastTestAt: null,
  rules: [],
  createdAt: 't',
  updatedAt: 't',
};
const session = {
  id: '12345678-1234-1234-1234-123456789abc',
  title: 'Continuer le chantier',
  cwd: '/srv/original',
  updatedAt: '2026-11-12T09:00:00Z',
};
const ouvrir = (result = [session], onClose = vi.fn()) =>
  setup(
    <>
      <NouvelleDiscussion server={server} onClose={onClose} />
      <Chemin />
    </>,
    snapshot(),
    '/serveurs',
    {
      'GET /api/servers/srv_1/claude-sessions': json(200, result),
      'POST /api/servers/srv_1/discussions': json(201, { id: 'sd_fork' }),
    },
  );

test('reprise : choix avec titre, cwd et date, création Claude puis navigation', async () => {
  const onClose = vi.fn();
  const h = ouvrir([session], onClose);
  expect(h.calls.some((c) => c.url.endsWith('/claude-sessions'))).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Reprendre une session existante' }));
  const select = await screen.findByRole('combobox', { name: 'Session Claude' });
  const option = screen.getByRole('option', { name: /Continuer le chantier/ });
  expect(option.textContent).toContain('/srv/original');
  expect(option.textContent).toContain('2026');
  expect(
    (screen.getByRole('button', { name: 'Créer et ouvrir' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.change(select, { target: { value: session.id } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Nom' }), {
    target: { value: ' Reprise VPS ' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Créer et ouvrir' }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(h.calls.find((c) => c.method === 'POST')?.body).toEqual({
    name: 'Reprise VPS',
    kind: 'claude',
    resumeSessionId: session.id,
  });
  expect(screen.getByTestId('chemin-courant').textContent).toBe(
    '/serveurs/srv_1/discussions/sd_fork',
  );
});

test('liste vide et retour au mode Nouvelle', async () => {
  ouvrir([]);
  fireEvent.click(screen.getByRole('button', { name: 'Reprendre une session existante' }));
  await screen.findByText('Aucune session Claude disponible sur ce serveur.');
  expect(
    (screen.getByRole('button', { name: 'Créer et ouvrir' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Nouvelle' }));
  expect(screen.getByRole('combobox', { name: 'Agent' })).toBeTruthy();
});

test('erreur de listage affichée et création impossible', async () => {
  const h = ouvrir();
  h.respond.set(
    'GET /api/servers/srv_1/claude-sessions',
    json(502, { message: 'serveur indisponible' }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Reprendre une session existante' }));
  expect((await screen.findByRole('alert')).textContent).toContain('serveur indisponible');
  expect(
    (screen.getByRole('button', { name: 'Créer et ouvrir' }) as HTMLButtonElement).disabled,
  ).toBe(true);
});

test('aucune reprise proposée sans claude détecté', () => {
  setup(
    <NouvelleDiscussion server={{ ...server, detectedAgents: ['codex'] }} onClose={vi.fn()} />,
    snapshot(),
  );
  expect(screen.queryByRole('button', { name: 'Reprendre une session existante' })).toBeNull();
});
