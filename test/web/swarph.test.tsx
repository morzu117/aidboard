// @vitest-environment jsdom
import { cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { afterEach, expect, test } from 'vitest';
import { Swarph } from '../../web/src/ecrans/Swarph.js';
import { setup, snapshot } from './helpers.js';

afterEach(cleanup);

// Chantier 25 (D102) : la page explique ; elle ne connecte rien et n'écrit aucune config.
const node = (id: string) => document.querySelector(`[data-node="${id}"]`) as HTMLElement | null;
const app = (
  <Routes>
    <Route path="/" element={<p>accueil</p>} />
    <Route path="/swarph" element={<Swarph />} />
  </Routes>
);

test('D102 : sans mesh, ce qu’apporte swarph et la marche à suivre, sans aucun appel', async () => {
  const h = setup(app, snapshot(), '/swarph');
  await waitFor(() => expect(node('swarph.etapes')).not.toBeNull());
  expect(node('swarph.entete.titre')!.textContent).toBe('Connecter cet A-I-D à swarph');
  expect(node('swarph.etapes.onboard')!.textContent).toContain('swarph onboard');
  expect(node('swarph.etapes.config.exemple')!.textContent).toMatch(/^mesh:\n {2}cell: /);
  expect(node('swarph.etapes.relancer')!.textContent).toContain('Réglages');
  expect(node('swarph.configure')).toBeNull();
  // l'écran a sa barre, et la barre son lien vers ici
  expect(node('swarph.barre.swarph')!.getAttribute('href')).toBe('/swarph');
  expect(h.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  expect(h.calls.some((c) => c.url.startsWith('/api/mesh'))).toBe(false);
  await userEvent.click(node('swarph.retour')!);
  await waitFor(() => expect(document.body.textContent).toContain('accueil'));
});

test('D102 : mesh déjà configuré, la page renvoie à Réglages au lieu de réexpliquer', async () => {
  setup(
    app,
    snapshot({
      mesh: {
        state: {
          ecritures: false,
          proxyConfigure: false,
          connected: false,
          tailscale: 'running',
          monitor: 'stopped',
          pending: 0,
          since: null,
          cell: 'morzu-mac',
        },
        inbox: [],
        tailscaleManage: false,
      },
    }),
    '/swarph',
  );
  await waitFor(() => expect(node('swarph.configure')).not.toBeNull());
  expect(node('swarph.configure')!.textContent).toContain('morzu-mac');
  expect(node('swarph.configure.reglages')!.getAttribute('href')).toBe('/reglages#mesh');
  expect(node('swarph.etapes')).toBeNull();
});
