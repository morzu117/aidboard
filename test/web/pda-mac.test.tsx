// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { PanneauPda } from '../../web/src/ui/PanneauPda.js';
import { json, setup, snapshot } from './helpers.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function ouvrir(routes: Record<string, (body: unknown) => Response> = {}) {
  return setup(<PanneauPda etat={{ actif: false, relais: null }} />, snapshot({}), '/machines', {
    'GET /api/host/pda/appareils': json(200, [
      {
        id: 'a',
        nom: 'Téléphone A',
        etat: 'attente',
        empreinte: 'ABCD EFGH',
        cree_a: '2026-01-01',
      },
      { id: 'b', nom: 'Téléphone B', etat: 'actif', empreinte: 'IJKL MNOP', cree_a: '2026-01-01' },
      {
        id: 'c',
        nom: 'Téléphone C',
        etat: 'revoque',
        empreinte: 'QRST UVWX',
        cree_a: '2026-01-01',
      },
    ]),
    'GET /api/host/pda/cle': json(200, { clePublique: 'cle-courante' }),
    ...routes,
  });
}
test('allumage confirmé avec le relais, placeholder et erreur 409', async () => {
  const confirmation = vi.spyOn(window, 'confirm').mockReturnValue(false);
  const h = ouvrir({ 'PUT /api/host/pda': json(409, { error: 'conflit PDA' }) });
  const adresse = screen.getByLabelText('Adresse du relais');
  expect(adresse.getAttribute('placeholder')).toBe('https://relais.example.com');
  fireEvent.change(adresse, { target: { value: 'https://relais.example.com' } });
  fireEvent.click(screen.getByRole('switch'));
  expect(h.calls.some((c) => c.method === 'PUT')).toBe(false);
  expect(confirmation).toHaveBeenCalledWith(
    'Le Mac va contacter le relais https://relais.example.com. Les confirmations passeront par lui ; il ne peut pas en forger.',
  );
  confirmation.mockReturnValue(true);
  fireEvent.click(screen.getByRole('switch'));
  await screen.findByText('conflit PDA');
  expect(h.calls.find((c) => c.method === 'PUT')?.body).toEqual({
    actif: true,
    relais: 'https://relais.example.com',
  });
});
test('activation, révocation et rotation confirmées', async () => {
  const confirmation = vi.spyOn(window, 'confirm').mockReturnValue(false);
  ouvrir({
    'POST /api/host/pda/cle/tourner': json(200, { clePublique: 'nouvelle-cle' }),
  });
  await screen.findByText('ABCD EFGH');
  expect(screen.getAllByRole('button', { name: 'Activer' })).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Activer' }));
  expect(confirmation).toHaveBeenLastCalledWith(
    "L'empreinte affichée sur le téléphone est-elle exactement ABCD EFGH ?",
  );
  fireEvent.click(screen.getAllByRole('button', { name: 'Révoquer' })[0]!);
  expect(confirmation).toHaveBeenLastCalledWith('Révoquer l’appareil PDA Téléphone A ?');
  confirmation.mockReturnValue(true);
  fireEvent.click(screen.getByText('Faire tourner la clé'));
  expect(confirmation).toHaveBeenLastCalledWith(
    'Les téléphones devront repasser par le tailnet pour reprendre la nouvelle clé, et le relais doit recevoir la nouvelle clé publique.',
  );
  await screen.findByText('nouvelle-cle');
});
test('essai sans numéro, relu après trois secondes', async () => {
  ouvrir({
    'POST /api/host/pda/essai': json(200, { id: 'demande', numero: '9876' }),
    'GET /api/host/pda/demandes/demande': json(200, { etat: 'confirmee', numero: '9876' }),
  });
  fireEvent.click(screen.getByText('Envoyer une demande d’essai'));
  await screen.findByText('Demande envoyée, en attente…');
  expect(document.body.textContent).not.toContain('9876');
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Confirmée'), {
    timeout: 4500,
  });
  expect(document.body.textContent).not.toContain('9876');
});

test('activation et révocation relisent la liste, une 502 est affichée', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  const h = ouvrir({
    'POST /api/host/pda/appareils/a/activer': json(200, { ok: true }),
    'POST /api/host/pda/appareils/a/revoquer': json(200, { ok: true }),
    'POST /api/host/pda/essai': json(502, { error: 'relais injoignable' }),
  });
  await screen.findByText('ABCD EFGH');
  fireEvent.click(screen.getByRole('button', { name: 'Activer' }));
  await waitFor(() =>
    expect(h.calls.filter((c) => c.url === '/api/host/pda/appareils')).toHaveLength(2),
  );
  await waitFor(() =>
    expect((screen.getByRole('button', { name: 'Activer' }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
  fireEvent.click(screen.getAllByRole('button', { name: 'Révoquer' })[0]!);
  await waitFor(() =>
    expect(h.calls.filter((c) => c.url === '/api/host/pda/appareils')).toHaveLength(3),
  );
  await waitFor(() =>
    expect((screen.getByText('Envoyer une demande d’essai') as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
  fireEvent.click(screen.getByText('Envoyer une demande d’essai'));
  await screen.findByText('relais injoignable');
});
