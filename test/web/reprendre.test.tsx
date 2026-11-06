// @vitest-environment jsdom
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router';
import { afterEach, expect, test, vi } from 'vitest';
import type { ServerAgent } from '../../src/shared/model.js';
import { type AReprendre, Reprendre } from '../../web/src/dialogues/Reprendre.js';
import { agent, json, setup, snapshot, topic } from './helpers.js';

// Chantier 28 (D146, D147, D148) : le dialogue Reprendre.

afterEach(cleanup);
const node = (id: string) => document.querySelector(`[data-node="${id}"]`) as HTMLElement | null;
const text = (id: string) => node(id)?.textContent;
const radio = (o: string) =>
  node(`reprendre.option-${o}`)!.querySelector('input') as HTMLInputElement;
const valider = () => node('reprendre.valider') as HTMLButtonElement;

function Lieu() {
  const l = useLocation();
  return <p data-testid="lieu">{`${l.pathname}${l.search}`}</p>;
}
const lieu = () => screen.getByTestId('lieu').textContent;

const distant = (over: Partial<ServerAgent> = {}): ServerAgent => ({
  id: 'sa_1',
  discussionId: 'sd_1',
  kind: 'claude',
  sessionId: 'sess',
  status: 'error',
  tmuxSession: 'aid-sa_1',
  outOffset: 0,
  permissionMode: 'default',
  model: null,
  effort: null,
  createdAt: '2026-11-06T09:00:00Z',
  updatedAt: '2026-11-06T09:00:00Z',
  ...over,
});

function ouvrir(
  cible: AReprendre,
  routes: Record<string, (body: unknown) => Response> = {},
  onClose = vi.fn(),
) {
  const h = setup(
    <>
      <Routes>
        <Route path="*" element={<Reprendre cible={cible} onClose={onClose} />} />
      </Routes>
      <Lieu />
    </>,
    snapshot(),
    '/boite',
    routes,
  );
  return { h, onClose };
}

const enVeille = () =>
  agent({
    kind: 'claude',
    transport: 'stream',
    status: 'stopped',
    sessionId: 'sess',
    statusAt: new Date().toISOString(),
  });

test('local en veille : reprendre la session par défaut, Reconnecter grisé, puis le sujet sur l’agent', async () => {
  const { h, onClose } = ouvrir(
    { lieu: 'local', agent: enVeille(), topic: topic() },
    { 'POST /api/agents/ag_1/reprendre': json(202, { id: 'ag_1' }) },
  );
  expect(screen.getByRole('dialog', { name: 'claude est arrêté.' })).toBeTruthy();
  expect(text('reprendre.question')).toBe('Que veux-tu retrouver ?');
  expect(text('reprendre.situation.processus')).toBe('Processus : en veille');
  expect(text('reprendre.situation.dernier')).toBe("Dernier événement : à l'instant");
  expect(text('reprendre.situation.relance')).toBe('Aucune tâche n’a été relancée.');
  expect(radio('reconnecter').disabled).toBe(true);
  expect(text('reprendre.option-reconnecter.raison')).toBe(
    'Un agent local ne perd pas son suivi sans s’arrêter.',
  );
  expect(radio('reprendre').checked).toBe(true);
  expect(text('reprendre.option-reprendre.revient')).toBe(
    'Revient : La conversation de la session.',
  );
  expect(text('reprendre.option-reprendre.ne-revient-pas')).toBe(
    'Ne revient pas : Le tour interrompu : ses commandes sont à rejouer.',
  );
  expect(radio('transferer').disabled).toBe(false);
  expect(node('reprendre.verifier')).toBeNull();
  expect(valider().textContent).toBe('Reprendre la session');
  await userEvent.click(valider());
  expect(h.calls.some((c) => c.method === 'POST' && c.url === '/api/agents/ag_1/reprendre')).toBe(
    true,
  );
  await waitFor(() => expect(lieu()).toBe('/sujets/tp_1?agent=ag_1'));
  expect(onClose).toHaveBeenCalled();
});

test('local : un agent du terminal ne se reprend pas, Transférer reste possible', () => {
  ouvrir({
    lieu: 'local',
    agent: agent({ kind: 'claude', transport: 'pty', status: 'stopped' }),
    topic: topic(),
  });
  expect(radio('reprendre').disabled).toBe(true);
  expect(text('reprendre.option-reprendre.raison')).toBe(
    'Cet agent ne se reprend pas : il est mort avec son terminal.',
  );
  expect(radio('transferer').checked).toBe(true);
  expect(valider().textContent).toBe('Transférer');
});

test('local : une reprise refusée s’affiche, le dialogue reste', async () => {
  const { onClose } = ouvrir(
    { lieu: 'local', agent: enVeille(), topic: topic() },
    { 'POST /api/agents/ag_1/reprendre': json(409, { error: 'worktree introuvable' }) },
  );
  await userEvent.click(valider());
  expect((await screen.findByRole('alert')).textContent).toBe('worktree introuvable');
  expect(onClose).not.toHaveBeenCalled();
  expect(valider().disabled).toBe(false);
});

const PROCESSUS = 'GET /api/server-agents/sa_1/processus';

test('serveur vivant, suivi coupé : Reconnecter par défaut, reprise grisée, puis la discussion', async () => {
  const { h } = ouvrir(
    { lieu: 'serveur', agent: distant({ suivi: 'coupe' }), serverId: 'sv_1' },
    {
      [PROCESSUS]: json(200, { etat: 'vivant', dernierEvenement: '2026-11-06T09:00:00Z' }),
      'POST /api/server-agents/sa_1/rattacher': json(202, { id: 'sa_1' }),
    },
  );
  expect(screen.getByRole('dialog', { name: 'Le suivi de claude est coupé.' })).toBeTruthy();
  // sonde en cours : rien n'est possible encore
  expect(text('reprendre.situation.processus')).toBe('Processus : vérification…');
  await waitFor(() => expect(radio('reconnecter').checked).toBe(true));
  expect(text('reprendre.situation.processus')).toBe('Processus : il répond sur le serveur');
  expect(radio('reprendre').disabled).toBe(true);
  expect(text('reprendre.option-reprendre.raison')).toBe(
    'Le processus répond : le relancer couperait son tour.',
  );
  expect(text('reprendre.option-transferer.raison')).toBe(
    'Le transfert ne vaut que pour un sujet local.',
  );
  expect(valider().textContent).toBe('Reconnecter');
  await userEvent.click(valider());
  expect(h.calls.some((c) => c.url === '/api/server-agents/sa_1/rattacher')).toBe(true);
  expect(h.calls.some((c) => c.url === '/api/server-agents/sa_1/relancer')).toBe(false);
  await waitFor(() => expect(lieu()).toBe('/serveurs/sv_1/discussions/sd_1'));
});

test('serveur arrêté, session perdue : reprendre la session relance', async () => {
  const { h } = ouvrir(
    { lieu: 'serveur', agent: distant({ suivi: 'echec' }), serverId: 'sv_1' },
    {
      [PROCESSUS]: json(200, { etat: 'arrete', dernierEvenement: null }),
      'POST /api/server-agents/sa_1/relancer': json(202, { id: 'sa_1' }),
    },
  );
  expect(screen.getByRole('dialog', { name: 'La session de claude est perdue.' })).toBeTruthy();
  await waitFor(() => expect(radio('reprendre').checked).toBe(true));
  expect(radio('reconnecter').disabled).toBe(true);
  expect(text('reprendre.option-reconnecter.raison')).toBe(
    'Le processus est arrêté : rien à rattacher.',
  );
  await userEvent.click(valider());
  expect(h.calls.some((c) => c.url === '/api/server-agents/sa_1/relancer')).toBe(true);
  await waitFor(() => expect(lieu()).toBe('/serveurs/sv_1/discussions/sd_1'));
});

test('serveur injoignable : rien n’est possible ; « Vérifier à nouveau » relance la sonde', async () => {
  let reponse = { etat: 'injoignable', dernierEvenement: null as string | null };
  const { h } = ouvrir(
    { lieu: 'serveur', agent: distant(), serverId: 'sv_1' },
    { [PROCESSUS]: () => json(200, reponse)() },
  );
  await waitFor(() =>
    expect(text('reprendre.situation.processus')).toBe('Processus : serveur injoignable'),
  );
  for (const o of ['reconnecter', 'reprendre', 'transferer']) expect(radio(o).disabled).toBe(true);
  expect(text('reprendre.option-reconnecter.raison')).toBe('Le serveur ne répond pas.');
  expect(valider().disabled).toBe(true);
  reponse = { etat: 'vivant', dernierEvenement: null };
  await userEvent.click(node('reprendre.verifier')!);
  await waitFor(() => expect(radio('reconnecter').checked).toBe(true));
  expect(h.calls.filter((c) => c.url === '/api/server-agents/sa_1/processus')).toHaveLength(2);
});
