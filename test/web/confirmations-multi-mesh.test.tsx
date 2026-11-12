// @vitest-environment jsdom
import { cleanup, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { PanneauConfirmations } from '../../web/src/ui/PanneauConfirmations.js';
import { json, setup, snapshot } from './helpers.js';

afterEach(cleanup);
test('Mac : nom en tête des demandes ouvertes et récentes', async () => {
  const demande = {
    id: 'test',
    action: 'mesh.ecrire',
    classe: 'toujours',
    resume: 'Résumé signé',
    echeance: Date.now() + 300000,
    etat: 'ouverte',
    resultat: null,
    mesh: { nom: 'perso', cell: 'peer-a' },
  };
  setup(<PanneauConfirmations />, snapshot(), '/', {
    'GET /api/confirmations': json(200, {
      ouvertes: [demande],
      recentes: [{ ...demande, id: 'recent', etat: 'consommee', resultat: 'executee' }],
    }),
    'GET /api/confirmations/reglage': json(200, { arme: false, actions: [], bandeau: null }),
  });
  const bandeaux = await screen.findAllByText('Mesh : perso');
  expect(bandeaux).toHaveLength(2);
  for (const bandeau of bandeaux) expect(bandeau.parentElement!.firstElementChild).toBe(bandeau);
  expect(screen.queryByText(/cell peer-a/)).toBeNull();
});
