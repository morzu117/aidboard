// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { Boite } from '../../web/src/ecrans/Boite.js';
import { FakeSocket, json, setup, snapshot } from './helpers.js';
const p = { id: 1, sujet: 's', carte: 42, etape: 'review' };
afterEach(cleanup);
async function ouvrir(code = 'succes', status = 200, detail?: string) {
  let propositions = [p];
  const etat = snapshot();
  etat.mesh = {
    state: {
      cell: 'peer-a',
      ecritures: true,
      proxyConfigure: true,
      superviseur: null,
      connected: true,
      tailscale: 'running',
      monitor: 'running',
      pending: 0,
      since: null,
    },
    inbox: [],
    tailscaleManage: false,
  };
  const h = setup(<Boite />, etat, '/boite', {
    'GET /api/nav': json(200, { groups: [], placements: [], prefs: { reduit: false } }),
    'GET /api/swairm/propositions': json(200, []),
    'GET /api/aid/propositions': () => json(200, propositions)(),
    'DELETE /api/aid/propositions/1': () => {
      propositions = [];
      return json(200, { ok: true })();
    },
    'GET /api/aid/propositions/1/apercu': json(200, {
      params: { carte: 42, etape: 'review', attendu: { stage: 'build', stageVersion: 2 } },
      resume: 'Déplace la carte #42 de build vers review. Aucune obligation ni message.',
    }),
    'POST /api/swarph/etat/envoyer': json(202, { confirmation: 'conf-test' }),
    'GET /api/confirmations': () => {
      if (code === 'succes') propositions = [];
      return json(200, {
        ouvertes: [],
        recentes: [
          {
            id: 'conf-test',
            resultat: code === 'succes' ? 'executee' : 'echouee',
            etat: 'confirmee',
            envoi: {
              code,
              status,
              detail,
              warn: code === 'succes' ? 'Avertissement du gateway' : undefined,
            },
          },
        ],
      })();
    },
  });
  await waitFor(() => expect(FakeSocket.all.length).toBeGreaterThan(0));
  act(() => FakeSocket.all[0]!.open());
  await screen.findByText('Déplacer la carte #42 vers review');
  return h;
}
test('Boîte : aperçu exact, fermer et Ignorer sans écriture mesh', async () => {
  const h = await ouvrir();
  fireEvent.click(screen.getByRole('button', { name: 'Ouvrir' }));
  await screen.findByText(
    'Déplace la carte #42 de build vers review. Aucune obligation ni message.',
  );
  expect(h.calls.filter((c) => c.method === 'POST')).toEqual([]);
  fireEvent.click(screen.getByRole('button', { name: 'Fermer' }));
  fireEvent.click(screen.getByRole('button', { name: 'Ignorer' }));
  await waitFor(() => expect(screen.queryByText('Déplacer la carte #42 vers review')).toBeNull());
  expect(h.calls.filter((c) => c.method === 'POST')).toEqual([]);
});
test('409 confirm-flow : texte brut, aucun bouton ni autre envoi, proposition conservée', async () => {
  const h = await ouvrir(
    'upstream_error',
    409,
    'stage gate <b>swarph board cards confirm-flow</b>',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Ouvrir' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Envoyer' }));
  const r = await screen.findByText(
    "Porte d'étape : stage gate <b>swarph board cards confirm-flow</b>",
  );
  expect(r.querySelector('b')).toBeNull();
  expect(screen.queryByRole('button', { name: /confirm-flow/ })).toBeNull();
  expect(h.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  expect(screen.getByRole('button', { name: 'Envoyer' }).hasAttribute('disabled')).toBe(true);
  expect(screen.getByText('Déplacer la carte #42 vers review')).toBeTruthy();
});
test('succès confirmé : proposition fermée', async () => {
  const h = await ouvrir();
  fireEvent.click(screen.getByRole('button', { name: 'Ouvrir' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Envoyer' }));
  await waitFor(() => expect(screen.queryByText('Déplacer la carte #42 vers review')).toBeNull());
  expect(screen.getByText('Avertissement du gateway')).toBeTruthy();
  expect(h.calls.find((c) => c.url === '/api/swarph/etat/envoyer')?.body).toMatchObject({
    action: 'carte.deplacer',
    propositionAid: 1,
  });
});
