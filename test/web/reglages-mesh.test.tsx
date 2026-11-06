// @vitest-environment jsdom
import { act, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test } from 'vitest';
import type { MeshDm, MeshState } from '../../src/shared/model.js';
import { Reglages } from '../../web/src/ecrans/Reglages.js';
import { ageLecture, etatMonitor } from '../../web/src/ui/pastille.js';
import { FakeSocket, setup, snapshot } from './helpers.js';

afterEach(cleanup);

// Chantier 25 (D99, D99 bis, D100) : la section Mesh de Réglages et les textes du monitor.
const node = (id: string) => document.querySelector(`[data-node="${id}"]`) as HTMLElement | null;
const text = (id: string) => node(id)?.textContent;
const ilYa = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

const dm = (id: number, kind: MeshDm['kind'], seenAt: string | null = null): MeshDm => ({
  id,
  threadId: null,
  from: 'mesh-gw',
  to: 'morzu-mac',
  kind,
  content: 'x',
  createdAt: ilYa(10),
  replyTo: null,
  obligationId: null,
  seenAt,
  decidedAt: null,
});
const etat = (over: Partial<MeshState> = {}): MeshState => ({
  connected: true,
  tailscale: 'running',
  monitor: 'running',
  pending: 1,
  since: ilYa(30),
  cell: 'morzu-mac',
  ...over,
});
const avecMesh = (over: Partial<MeshState> = {}, checkedAt: string | null = null, manage = false) =>
  snapshot({
    mesh: {
      state: etat(over),
      inbox: [dm(1, 'question'), dm(2, 'unblock'), dm(3, 'fyi'), dm(4, 'question', ilYa(1))],
      tailscaleManage: manage,
      checkedAt,
    },
  });

test('D99 : le monitor se dit tel qu’il est mesuré, jamais « connecté »', () => {
  const now = Date.now();
  expect(etatMonitor(etat(), 2, false, now)).toBe('monitor actif · 2 à traiter');
  expect(etatMonitor(etat({ connected: false, monitor: 'stale' }), 0, false, now)).toBe(
    'monitor périmé',
  );
  expect(etatMonitor(etat({ connected: false, monitor: 'stopped' }), 0, false, now)).toBe(
    'hors mesh depuis 30 min',
  );
  expect(etatMonitor(etat({ connected: false, monitor: 'stopped', since: null }), 0, false)).toBe(
    'monitor arrêté',
  );
  expect(etatMonitor(etat({ connected: false, monitor: 'absent' }), 0, false)).toBe(
    'swarph introuvable',
  );
  expect(etatMonitor(etat({ connected: false, tailscale: 'stopped' }), 0, false)).toBe(
    'monitor actif · Tailscale arrêté',
  );
  expect(etatMonitor(etat(), 0, true)).toBe('déconnexion du mesh…');
  expect(etatMonitor(etat({ connected: false }), 0, true)).toBe('connexion au mesh…');
  for (const s of ['running', 'stopped', 'stale', 'absent'] as const)
    expect(etatMonitor(etat({ monitor: s, connected: s === 'running' }), 0, false)).not.toMatch(
      /connecté/,
    );
});

test('D99 : l’âge de la lecture ne s’affiche qu’au-delà de 90 s, et seulement connecté', () => {
  const now = Date.now();
  expect(ageLecture(etat(), null, now)).toBeNull();
  expect(ageLecture(etat(), new Date(now - 60_000).toISOString(), now)).toBeNull();
  expect(ageLecture(etat(), new Date(now - 5 * 60_000).toISOString(), now)).toBe('lu il y a 5 min');
  expect(ageLecture(etat({ connected: false }), ilYa(5), now)).toBeNull();
});

test('D100 : connecté, Déconnecter demande confirmation en nommant la cell, puis appelle disconnect', async () => {
  const h = setup(<Reglages />, avecMesh(), '/reglages#mesh');
  await waitFor(() => expect(node('reglages.mesh.etat')).not.toBeNull());
  expect(node('reglages.mesh')?.id).toBe('mesh');
  expect(text('reglages.mesh.etat')).toBe('monitor actif · 2 à traiter');
  expect(text('reglages.mesh.detail')).toBe(
    'Cell morzu-mac · Tailscale actif · 1 DM en attente côté monitor',
  );
  expect(node('reglages.mesh.connecter')).toBeNull();
  await userEvent.click(node('reglages.mesh.deconnecter')!);
  expect(text('reglages.mesh.confirmation')).toBe(
    'Le monitor de la cell morzu-mac s’arrête. Toutes les sessions de cette cell, Claude compris, ne seront plus réveillées par les DM jusqu’à la reconnexion.',
  );
  expect(h.calls.some((c) => c.url.startsWith('/api/mesh/'))).toBe(false);
  await userEvent.click(node('reglages.mesh.confirmer')!);
  await waitFor(() =>
    expect(h.calls.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual([
      '/api/mesh/disconnect',
    ]),
  );
  expect(node('reglages.mesh.confirmation')).toBeNull();
  expect(text('reglages.mesh.etat')).toBe('déconnexion du mesh…');
  expect((node('reglages.mesh.deconnecter') as HTMLButtonElement).disabled).toBe(true);
});

test('D100 : Annuler ne déconnecte rien', async () => {
  const h = setup(<Reglages />, avecMesh());
  await waitFor(() => expect(node('reglages.mesh.deconnecter')).not.toBeNull());
  await userEvent.click(node('reglages.mesh.deconnecter')!);
  await userEvent.click(document.querySelector('.dialogue-actions .bouton:not(.bouton--danger)')!);
  expect(node('reglages.mesh.confirmation')).toBeNull();
  expect(h.calls.some((c) => c.url.startsWith('/api/mesh/'))).toBe(false);
});

test('D100 : hors mesh, Connecter appelle connect sans confirmation', async () => {
  const h = setup(<Reglages />, avecMesh({ connected: false, monitor: 'stopped' }));
  await waitFor(() => expect(node('reglages.mesh.connecter')).not.toBeNull());
  expect(text('reglages.mesh.etat')).toBe('hors mesh depuis 30 min');
  await userEvent.click(node('reglages.mesh.connecter')!);
  await waitFor(() =>
    expect(h.calls.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual([
      '/api/mesh/connect',
    ]),
  );
  expect(text('reglages.mesh.etat')).toBe('connexion au mesh…');
});

test('D100 : Tailscale arrêté sans manage, Connecter est désactivé et dit pourquoi', async () => {
  setup(<Reglages />, avecMesh({ connected: false, monitor: 'stopped', tailscale: 'stopped' }));
  await waitFor(() => expect(node('reglages.mesh.connecter')).not.toBeNull());
  expect((node('reglages.mesh.connecter') as HTMLButtonElement).disabled).toBe(true);
  expect(text('reglages.mesh.bloque')).toMatch(/^Tailscale est arrêté/);
});

test('D99 bis : une lecture vieille de 5 min se voit, l’éphémère mesh.checked la rafraîchit', async () => {
  setup(<Reglages />, avecMesh({}, ilYa(5)));
  await waitFor(() => expect(text('reglages.mesh.age')).toBe('lu il y a 5 min'));
  act(() =>
    FakeSocket.all.at(-1)!.push({
      kind: 'ephemeral',
      type: 'mesh.checked',
      checkedAt: new Date().toISOString(),
    }),
  );
  await waitFor(() => expect(node('reglages.mesh.age')).toBeNull());
});

test('sans cell configurée, la section dit pourquoi il n’y a rien à connecter', async () => {
  setup(<Reglages />, snapshot());
  await waitFor(() => expect(node('reglages.mesh.absent')).not.toBeNull());
  expect(node('reglages.mesh.connecter')).toBeNull();
});
