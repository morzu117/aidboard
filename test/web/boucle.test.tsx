// @vitest-environment jsdom
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { afterEach, expect, test } from 'vitest';
import type { EtatBoucle, Tentative } from '../../src/daemon/boucle/etat.js';
import { Sujet } from '../../web/src/ecrans/Sujet.js';
import { json, setup, snapshot, topic, ws } from './helpers.js';

const route = '/api/topics/tp_1/boucle';
const plan = 'Un plan pour le sujet fictif.';
const tete = 'a'.repeat(40);

const phases = [
  ['plan', 'Plan', true],
  ['attente_go', 'En attente du GO', false],
  ['acceptation', 'Acceptation', true],
  ['dev', 'Dev', true],
  ['gate', 'Gate', true],
  ['revue', 'Revue', true],
  ['triage', 'Triage', false],
  ['livraison_prete', 'Livraison prête', false],
  ['escalade', 'Escalade', false],
  ['arretee', 'Arrêtée', false],
] as const satisfies ReadonlyArray<readonly [EtatBoucle['phase'], string, boolean]>;

const etapePlan: Tentative = {
  type: 'plan',
  tentative: 1,
  agentId: null,
  debut: 1000,
  fin: 1030,
  echeance: null,
  teteDepart: tete,
  teteArrivee: tete,
  issue: 'pass',
};

afterEach(cleanup);

async function ouvrir(
  phase: EtatBoucle['phase'] | null,
  typeActif?: Tentative['type'],
  routes: Record<string, (body: unknown) => Response> = {},
) {
  const h = setup(
    <Routes>
      <Route path="/sujets/:topicId" element={<Sujet />} />
    </Routes>,
    snapshot({ workspaces: [ws()], topics: [topic()] }),
    '/sujets/tp_1',
    {
      [`GET ${route}`]: json(200, {
        phase,
        etapeCourante: typeActif
          ? { ...etapePlan, type: typeActif, issue: null, fin: undefined }
          : null,
        historique: phase && phase !== 'plan' ? [etapePlan] : [],
        plan: phase && phase !== 'plan' ? plan : null,
        escalade:
          phase === 'escalade' ? { raison: 'needs_input', question: 'Quel format ?' } : null,
        mesures: { tempsParEtapeMs: {}, interventionsHumaines: 0, redevs: 0 },
      }),
      ...routes,
    },
  );
  const bouton = await screen.findByRole('button', { name: 'Boucle' });
  expect(bouton.getAttribute('data-testid')).toBe('boucle-ouvrir');
  await userEvent.click(bouton);
  return h;
}

test.each(phases)(
  'phase %s : libellé, visibilité du GO et de l’arrêt',
  async (phase, libelle, actif) => {
    await ouvrir(phase, actif ? (phase as Tentative['type']) : undefined);
    expect((await screen.findByTestId('boucle-phase')).textContent).toContain(libelle);
    expect(Boolean(screen.queryByTestId('boucle-go'))).toBe(phase === 'attente_go');
    expect(Boolean(screen.queryByTestId('boucle-arreter'))).toBe(actif);
  },
);

test('en attente du GO, place le bouton GO sous le plan et affiche la tête et l’issue du plan', async () => {
  await ouvrir('attente_go');
  const texte = await screen.findByText(plan);
  const go = screen.getByRole('button', { name: 'GO' });
  expect(texte.compareDocumentPosition(go) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const historique = screen.getByTestId('boucle-historique');
  expect(historique.textContent).toContain('pass');
  expect(
    historique.querySelector(`[title="${tete}"]`) !== null ||
      historique.textContent?.includes(tete),
  ).toBe(true);
});

test('affiche la question et transmet le texte par POST à /boucle/reponse', async () => {
  const h = await ouvrir('escalade', undefined, {
    [`POST ${route}/reponse`]: json(200, { ok: true }),
  });
  expect(await screen.findByText('Quel format ?')).toBeTruthy();
  await userEvent.type(screen.getByLabelText('Réponse'), 'Un texte');
  await userEvent.click(screen.getByRole('button', { name: 'Envoyer la réponse' }));
  await waitFor(() =>
    expect(h.calls).toContainEqual({
      method: 'POST',
      url: `${route}/reponse`,
      body: { reponse: 'Un texte' },
    }),
  );
});
