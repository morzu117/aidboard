// @vitest-environment jsdom
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { AidClient } from '../../web/src/data/client.js';
import { AidProvider } from '../../web/src/data/useAidState.js';
import { DemanderAvis } from '../../web/src/ui/DemanderAvis.js';
import { Swarph } from '../../web/src/ecrans/Swarph.js';
import { render } from '@testing-library/react';
import { FakeSocket, json, setup, snapshot } from './helpers.js';

afterEach(cleanup);
const etat = { enCours: false, depuis: null, budgetUsd: 0.5 };
function boite(
  reponse: () => Promise<Response> = async () =>
    new Response(JSON.stringify({ ok: false, kind: 'annule', readAt: 't' })),
) {
  const fetchImpl = vi.fn(async (url: string, _init?: RequestInit) =>
    (void _init, url === '/api/state') ? new Response(JSON.stringify(snapshot())) : reponse(),
  );
  const client = new AidClient({
    fetchImpl: fetchImpl as typeof fetch,
    socketFactory: () => ({ close() {} }) as WebSocket,
  });
  render(
    <AidProvider client={client}>
      <DemanderAvis etat={etat} onClose={() => {}} />
    </AidProvider>,
  );
  return fetchImpl;
}
test('coût, validation et aucun appel à l’ouverture ou pendant la frappe ; confirmation au clic seul', async () => {
  const fetchImpl = boite();
  expect(screen.getByText('Coût maximal : 1.50 USD')).toBeTruthy();
  const envoyer = screen.getByRole('button', { name: 'Envoyer' }) as HTMLButtonElement;
  expect(envoyer.disabled).toBe(true);
  await userEvent.type(screen.getByLabelText('Question'), '1. Tester ?');
  await userEvent.selectOptions(screen.getByLabelText('N'), '5');
  expect(screen.getByText('Coût maximal : 2.50 USD')).toBeTruthy();
  await userEvent.click(screen.getByLabelText('sonnet'));
  await userEvent.click(screen.getByLabelText('opus'));
  expect(envoyer.disabled).toBe(true);
  await userEvent.click(screen.getByLabelText('haiku'));
  expect(envoyer.disabled).toBe(false);
  expect(fetchImpl.mock.calls.filter(([url]) => url !== '/api/state')).toHaveLength(0);
  await userEvent.click(envoyer);
  await screen.findByText('Annulé');
  const appels = fetchImpl.mock.calls.filter(([url]) => url !== '/api/state');
  expect(appels).toHaveLength(1);
  expect(appels[0]?.[0]).toBe('/api/swairm/ask');
  expect(appels[0]?.[1]?.headers).toMatchObject({ 'X-AID-Confirm': 'ask' });
  expect(JSON.parse(String(appels[0]?.[1]?.body))).toEqual({
    question: '1. Tester ?',
    n: 5,
    modeles: ['haiku'],
  });
});
test('409', async () => {
  boite(async () => new Response(JSON.stringify({ error: 'occupé' }), { status: 409 }));
  await userEvent.type(screen.getByLabelText('Question'), 'Question');
  await userEvent.click(screen.getByRole('button', { name: 'Envoyer' }));
  expect((await screen.findByRole('alert')).textContent).toBe('Une demande est déjà en cours.');
});
test('attente, temps écoulé et annulation sans en-tête de confirmation', async () => {
  let terminer!: (r: Response) => void;
  let appels = 0;
  const fetchImpl = boite(() =>
    ++appels === 1
      ? new Promise((r) => {
          terminer = r;
        })
      : Promise.resolve(new Response(JSON.stringify(etat))),
  );
  await userEvent.type(screen.getByLabelText('Question'), 'Question');
  await userEvent.click(screen.getByRole('button', { name: 'Envoyer' }));
  expect(screen.getByRole('status').textContent).toContain('Temps écoulé :');
  await userEvent.click(screen.getByRole('button', { name: 'Annuler' }));
  const annulation = fetchImpl.mock.calls.find(([url]) => url.endsWith('/annuler'));
  expect(annulation).toBeTruthy();
  expect(annulation?.[1]?.headers).not.toHaveProperty('X-AID-Confirm');
  terminer(new Response(JSON.stringify({ ok: false, kind: 'annule', readAt: 't' })));
  await screen.findByText('Annulé');
});
test('bouton absent sans swairm', async () => {
  const h = setup(<Swarph />, snapshot());
  await screen.findByText('Connecter cet A-I-D à swarph');
  expect(screen.queryByRole('button', { name: 'Demander N avis' })).toBeNull();
  expect(h.calls.some((c) => c.url.startsWith('/api/swairm'))).toBe(false);
});
test('historique en lecture et ouverture sans nouvel appel', async () => {
  const h = setup(<Swarph />, snapshot({ swairm: { enabled: true } }), '/', {
    'GET /api/swairm/ask/etat': json(200, etat),
    'GET /api/swairm/asks': json(200, {
      ok: true,
      data: {
        demandes: [
          {
            id: '20261109T071500Z-3f2a',
            genere_a: '2026-11-09T07:15:00Z',
            question: 'Question archivée',
            n: 3,
            accord: [{ n: 1, accord: 'partage' }],
          },
        ],
      },
      readAt: 't',
    }),
    'GET /api/swairm/asks/20261109T071500Z-3f2a': json(200, {
      ok: false,
      kind: 'format',
      readAt: 't',
    }),
  });
  const bouton = await screen.findByRole('button', { name: 'Demander N avis' });
  await act(async () => FakeSocket.all[0]!.open());
  await waitFor(() => expect((bouton as HTMLButtonElement).disabled).toBe(false));
  const avant = h.calls.length;
  await userEvent.click(bouton);
  await userEvent.type(screen.getByLabelText('Question'), 'Question');
  expect(h.calls).toHaveLength(avant);
  await userEvent.click(screen.getByRole('button', { name: 'Fermer' }));
  await userEvent.click(screen.getByRole('button', { name: /Question archivée/ }));
  await screen.findByText('Réponse illisible');
  expect(h.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
});

test('texte blanc désactivé et résultat ouvert dans le tableau', async () => {
  boite(
    async () =>
      new Response(
        JSON.stringify({
          ok: true,
          readAt: 't',
          data: {
            question: 'Question',
            sous_questions: [{ n: 1, texte: 'Tester ?' }],
            avis: [],
            accord: [],
            cout_total_usd: 0.04,
          },
        }),
      ),
  );
  await userEvent.type(screen.getByLabelText('Question'), '   ');
  expect((screen.getByRole('button', { name: 'Envoyer' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  await userEvent.type(screen.getByLabelText('Question'), 'Tester ?');
  await userEvent.click(screen.getByRole('button', { name: 'Envoyer' }));
  expect(await screen.findByRole('table')).toBeTruthy();
  expect(screen.getByText('Coût total : 0.04 USD')).toBeTruthy();
});
