// @vitest-environment jsdom
import { cleanup, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { limitesBoucle } from '../../src/shared/limites-boucle.js';
import { Boucle } from '../../web/src/ecrans/Boucle.js';
import { utiliserBac } from '../isolation-acceptation-temoins.js';
import { json, setup, snapshot } from './helpers.js';

utiliserBac();
afterEach(cleanup);

test('la vue Boucle affiche la limite d’isolation partagée incluant le gate', async () => {
  setup(<Boucle sujetId="tp_1" />, snapshot(), '/', {
    'GET /api/topics/tp_1/boucle': json(200, {
      phase: null,
      etapeCourante: null,
      historique: [],
      plan: null,
      escalade: null,
      mesures: { tempsParEtapeMs: {}, interventionsHumaines: 0, redevs: 0 },
    }),
  });
  await screen.findByRole('heading', { name: 'Aucune boucle' });
  const limite = await screen.findByText(limitesBoucle);
  expect(limite.textContent).toMatch(
    /(?:isolation|bwrap)[^.!?]*gate|gate[^.!?]*(?:isolation|bwrap)/i,
  );
});
