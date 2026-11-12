// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { Boite } from '../../web/src/ecrans/Boite.js';
import { FakeSocket, json, setup, snapshot } from './helpers.js';

const proposition = {
  id: 1,
  projet: 'exemple/depot',
  sujet: '41',
  titre: '<b>Un sujet</b>',
  carte: 42,
  etat: 'plan_validated',
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
async function ouvrir(code = 'succes') {
  let propositions = [proposition];
  const h = setup(<Boite />, snapshot(), '/boite', {
    'GET /api/nav': json(200, { groups: [], placements: [], prefs: { reduit: false } }),
    'GET /api/swairm/propositions': () => json(200, propositions)(),
    'DELETE /api/swairm/propositions/1': () => {
      propositions = [];
      return json(200, { ok: true })();
    },
    'POST /api/swarph/ecrire/apercu': json(200, {
      ok: true,
      aBlanc: true,
      texte: 'aperçu',
      argv: [],
      resume: 'Note',
      rappel: null,
    }),
    'POST /api/swarph/ecrire/envoyer': json(202, { confirmation: 'confirmation-test' }),
    'GET /api/confirmations': () => {
      if (code === 'succes') propositions = [];
      return json(200, {
        ouvertes: [],
        recentes: [
          {
            id: 'confirmation-test',
            resultat: code === 'succes' ? 'executee' : 'echouee',
            etat: 'confirmee',
            envoi: { code, open_obligations: [] },
          },
        ],
      })();
    },
  });
  await waitFor(() => expect(FakeSocket.all.length).toBeGreaterThan(0));
  act(() => FakeSocket.all[0]!.open());
  await screen.findByText('Proposer une note sur la carte #42');
  return h;
}

test('Boîte : préremplissage D288 exact, texte brut, aucun envoi à l’ouverture ; fermer conserve la proposition', async () => {
  const h = await ouvrir();
  expect(screen.getByText('<b>Un sujet</b> · plan validé').querySelector('b')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Ouvrir' }));
  expect((screen.getByLabelText('Texte') as HTMLTextAreaElement).value).toBe(
    'Swairm : <b>Un sujet</b> — plan validé.',
  );
  expect((screen.getByLabelText('Carte') as HTMLInputElement).value).toBe('42');
  expect((screen.getByLabelText('Kind') as HTMLSelectElement).value).toBe('fyi');
  expect(h.calls.filter((c) => c.method === 'POST')).toEqual([]);
  fireEvent.click(screen.getByRole('button', { name: 'Fermer' }));
  expect(screen.getByText('Proposer une note sur la carte #42')).toBeTruthy();
});

test('Ignorer ferme la proposition sans envoi', async () => {
  const h = await ouvrir();
  fireEvent.click(screen.getByRole('button', { name: 'Ignorer' }));
  await waitFor(() => expect(screen.queryByText('Proposer une note sur la carte #42')).toBeNull());
  expect(h.calls.filter((c) => c.method === 'POST')).toEqual([]);
});

test.each(['succes', 'connexion'])(
  'envoi confirmé %s : fermeture uniquement après succès',
  async (code) => {
    const h = await ouvrir(code);
    fireEvent.click(screen.getByRole('button', { name: 'Ouvrir' }));
    fireEvent.click(screen.getByRole('button', { name: "Voir l'aperçu" }));
    fireEvent.click(await screen.findByRole('button', { name: 'Envoyer' }));
    await waitFor(() => expect(h.calls.some((c) => c.url === '/api/confirmations')).toBe(true));
    expect(h.calls.find((c) => c.url === '/api/swarph/ecrire/envoyer')?.body).toEqual({
      mesh: 'principal',
      action: 'carte.note',
      params: { carte: 42, a: null, kind: 'fyi', texte: 'Swairm : <b>Un sujet</b> — plan validé.' },
      propositionSwairm: 1,
    });
    if (code === 'succes')
      await waitFor(() =>
        expect(screen.queryByText('Proposer une note sur la carte #42')).toBeNull(),
      );
    else expect(screen.getByText('Proposer une note sur la carte #42')).toBeTruthy();
  },
);

test('host : aucun abonnement aux propositions', async () => {
  const { render } = await import('@testing-library/react');
  const { AidClient } = await import('../../web/src/data/client.js');
  const { AidProvider } = await import('../../web/src/data/useAidState.js');
  const { usePropositionsSwairm } = await import('../../web/src/ui/PropositionsSwairm.js');
  function Lecture() {
    const { propositions } = usePropositionsSwairm();
    return <span>{propositions.length}</span>;
  }
  const appels: string[] = [];
  const client = new AidClient({
    flux: 'signal',
    fetchImpl: (async (url: string) => {
      appels.push(url);
      return new Response(JSON.stringify({ mesh: null }), { status: 200 });
    }) as typeof fetch,
    socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
  });
  render(
    <AidProvider client={client}>
      <Lecture />
    </AidProvider>,
  );
  await waitFor(() => expect(client.getSnapshot().appareil).toBeTruthy());
  act(() => FakeSocket.all.at(-1)!.open());
  expect(appels).not.toContain('/api/swairm/propositions');
});
