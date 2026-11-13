// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { avatarCell, PALETTE_AVATARS } from '../../src/shared/avatars.js';
import { AvatarCell } from '../../web/src/ui/AvatarCell.js';
import { AidClient } from '../../web/src/data/client.js';
import { AidProvider } from '../../web/src/data/useAidState.js';
import { json, setup, snapshot } from './helpers.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const disques = () => [...document.querySelectorAll<HTMLElement>('.avatar-cell')];

test('disque décoratif, nom conservé et anneau avec titre seulement sur sa cell', () => {
  render(
    <>
      <AvatarCell nom="peer-a" cellLocale="peer-a" />
      peer-a
      <AvatarCell nom="peer-b" cellLocale="peer-a" />
      peer-b
    </>,
  );
  expect(screen.getByText('peer-apeer-b')).toBeTruthy();
  expect(disques().map((d) => d.getAttribute('aria-hidden'))).toEqual(['true', 'true']);
  expect(disques()[0]!.title).toBe('cette cell');
  expect(disques()[0]!.classList.contains('avatar-cell--locale')).toBe(true);
  expect(disques()[1]!.title).toBe('');
  expect(disques()[1]!.classList.contains('avatar-cell--locale')).toBe(false);
});

test('lecture unique, surcharge partielle et complète partagées entre montages', async () => {
  const h = setup(
    <>
      <AvatarCell nom="peer-a" />
      <AvatarCell nom="peer-b" />
    </>,
    snapshot(),
    '/',
    {
      'GET /api/avatars': json(200, {
        avatars: { 'peer-a': { initiales: 'A1', couleur: 'bleu' }, 'peer-b': { couleur: 'rose' } },
      }),
    },
  );
  await waitFor(() => expect(disques()[0]!.dataset.initiales).toBe('A1'));
  expect(disques()[0]!.style.backgroundColor).toBe('rgb(110, 168, 255)');
  expect(disques()[1]!.dataset.initiales).toBe('PB');
  expect(disques()[1]!.style.backgroundColor).toBe('rgb(240, 122, 176)');
  cleanup();
  render(
    <AidProvider client={h.client}>
      <AvatarCell nom="peer-a" />
    </AidProvider>,
  );
  await waitFor(() => expect(disques()[0]!.dataset.initiales).toBe('A1'));
  expect(h.calls.filter((c) => c.url === '/api/avatars')).toHaveLength(1);
});

test.each([404, 500])(
  'route en erreur %s : avatar calculé, sans alerte ni nouvelle lecture',
  async (statut) => {
    const h = setup(<AvatarCell nom="peer-a" />, snapshot(), '/', {
      'GET /api/avatars': json(statut, {}),
    });
    await waitFor(() => expect(h.calls.some((c) => c.url === '/api/avatars')).toBe(true));
    const attendu = avatarCell('peer-a');
    expect(disques()[0]!.dataset.initiales).toBe(attendu.initiales);
    const palette = PALETTE_AVATARS.find((c) => c.id === attendu.couleur)!;
    const comparaison = document.createElement('span');
    comparaison.style.backgroundColor = palette.valeur;
    expect(disques()[0]!.style.backgroundColor).toBe(comparaison.style.backgroundColor);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(h.calls.filter((c) => c.url === '/api/avatars')).toHaveLength(1);
  },
);

test('erreur réseau : repli calculé', async () => {
  const client = new AidClient();
  const requete = vi
    .spyOn(client, 'request')
    .mockRejectedValue(new TypeError('réseau indisponible'));
  render(
    <AidProvider client={client}>
      <AvatarCell nom="peer-b" />
    </AidProvider>,
  );
  await waitFor(() => expect(requete).toHaveBeenCalledWith('GET', '/api/avatars'));
  expect(disques()[0]!.dataset.initiales).toBe('PB');
});

test('initiales hostiles traitées en texte décoratif React, couleur hors palette jamais appliquée', async () => {
  const texte = '<img src=x onerror=alert(1)>';
  setup(<AvatarCell nom="peer-a" />, snapshot(), '/', {
    'GET /api/avatars': json(200, { avatars: { 'peer-a': { initiales: texte, couleur: 'red' } } }),
  });
  await waitFor(() => expect(disques()[0]!.dataset.initiales).toBe(texte));
  expect(document.querySelector('img')).toBeNull();
  expect(disques()[0]!.style.backgroundColor).toBe('rgb(141, 148, 160)');
  expect(disques()[0]!.style.color).toBe('rgb(20, 22, 26)');
});

test('le client appareil n’affiche aucun avatar et ne lit pas la route locale', async () => {
  const client = new AidClient({ flux: 'signal' });
  const requete = vi.spyOn(client, 'request').mockRejectedValue(new Error('indisponible'));
  render(
    <AidProvider client={client}>
      <AvatarCell nom="peer-a" cellLocale="peer-a" />
    </AidProvider>,
  );
  await waitFor(() => expect(requete).toHaveBeenCalled());
  expect(disques()).toHaveLength(0);
  expect(requete.mock.calls.some(([, route]) => route === '/api/avatars')).toBe(false);
});
