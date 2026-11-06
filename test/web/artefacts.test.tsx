// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test } from 'vitest';
import type { Artefact, ArtefactsResponse } from '../../src/shared/artefacts.js';
import { AgentRoutesContext, routesDistantes } from '../../web/src/conversation/routes.js';
import { OngletArtefacts } from '../../web/src/ecrans/OngletArtefacts.js';
import { PanneauContexte } from '../../web/src/ecrans/PanneauContexte.js';
import { json, setup, snapshot } from './helpers.js';

afterEach(cleanup);

// Chantier 30 (D167, D168) : l'onglet Artefacts, sur des données synthétiques.

const LISTE = 'GET /api/topics/tp_1/artefacts';
const LIEN = 'POST /api/topics/tp_1/artefacts/lien';
const PORT = { disponible: true, port: 4880 };
const URL_1 = 'http://127.0.0.1:4880/a/jeton-synthetique-1';

const artefact = (
  path: string,
  type: Artefact['type'],
  status: Artefact['status'] = 'U',
): Artefact => ({
  path,
  name: path.split('/').pop()!,
  type,
  status,
  modifieA: '2026-11-06T10:00:00.000Z',
});

const reponse = (artefacts: Artefact[], etat = PORT): ArtefactsResponse => ({ artefacts, etat });

function liens() {
  let n = 0;
  return () => {
    n += 1;
    return new Response(
      JSON.stringify({
        url: `http://127.0.0.1:4880/a/jeton-synthetique-${n}`,
        aPart: `http://127.0.0.1:4880/v/jeton-synthetique-${n}`,
        expireA: 'x',
      }),
      { status: 200 },
    );
  };
}

test('liste vide : la phrase qui dit comment un agent en crée', async () => {
  setup(<OngletArtefacts topicId="tp_1" />, snapshot(), '/', { [LISTE]: json(200, reponse([])) });
  expect(
    await screen.findByText(
      'Aucun artefact sur ce sujet. Un agent en crée en écrivant un fichier .html, .md ou .svg.',
    ),
  ).toBeTruthy();
});

test('Markdown : rendu dans la page, ni cadre ni lien', async () => {
  const h = setup(<OngletArtefacts topicId="tp_1" />, snapshot(), '/', {
    [LISTE]: json(200, reponse([artefact('notes/synthese.md', 'md')])),
    'GET /api/topics/tp_1/files/content?path=notes%2Fsynthese.md': json(200, {
      content: '# Synthèse\n\nTexte du rapport.',
    }),
  });
  await userEvent.click(await screen.findByRole('button', { name: /synthese\.md/ }));
  expect(await screen.findByText('Texte du rapport.')).toBeTruthy();
  expect(document.querySelector('iframe')).toBeNull();
  expect(screen.queryByRole('link', { name: 'Ouvrir à part' })).toBeNull();
  expect(h.calls.some((c) => c.url.endsWith('/artefacts/lien'))).toBe(false);
});

test('HTML : un cadre aux attributs exacts, la phrase de la frontière, Ouvrir à part', async () => {
  const h = setup(<OngletArtefacts topicId="tp_1" />, snapshot(), '/', {
    [LISTE]: json(200, reponse([artefact('rapport.html', 'html', 'A')])),
    [LIEN]: liens(),
  });
  await userEvent.click(await screen.findByRole('button', { name: /rapport\.html/ }));
  const cadre = (await screen.findByTitle('Artefact rapport.html')) as HTMLIFrameElement;
  expect(cadre.getAttribute('src')).toBe(URL_1);
  expect(cadre.getAttribute('sandbox')).toBe('allow-scripts');
  expect(cadre.getAttribute('referrerpolicy')).toBe('no-referrer');
  expect(cadre.hasAttribute('allow')).toBe(false);
  expect(
    screen.getByText(
      'Ni fetch, ni XHR, ni WebSocket : cet artefact ne charge rien. Il peut encore naviguer dans son propre cadre.',
    ),
  ).toBeTruthy();
  const aPart = screen.getByRole('link', { name: 'Ouvrir à part' });
  // 30.9 (lab 91283) : l'enveloppe, plus l'artefact seul
  expect(aPart.getAttribute('href')).toBe('http://127.0.0.1:4880/v/jeton-synthetique-1');
  expect(aPart.getAttribute('target')).toBe('_blank');
  expect(aPart.getAttribute('rel')).toBe('noopener noreferrer');
  expect(h.calls.find((c) => c.url.endsWith('/artefacts/lien'))?.body).toEqual({
    path: 'rapport.html',
  });
});

test('Recharger redemande un lien et remonte le cadre', async () => {
  setup(<OngletArtefacts topicId="tp_1" />, snapshot(), '/', {
    [LISTE]: json(200, reponse([artefact('schema.svg', 'svg')])),
    [LIEN]: liens(),
  });
  await userEvent.click(await screen.findByRole('button', { name: /schema\.svg/ }));
  const avant = await screen.findByTitle('Artefact schema.svg');
  await userEvent.click(screen.getByRole('button', { name: 'Recharger' }));
  await waitFor(() =>
    expect(screen.getByTitle('Artefact schema.svg').getAttribute('src')).toBe(
      'http://127.0.0.1:4880/a/jeton-synthetique-2',
    ),
  );
  expect(screen.getByTitle('Artefact schema.svg')).not.toBe(avant);
  expect(screen.getByText(/^Lu à /)).toBeTruthy();
});

test('D167 (lab, MUST 1) : au deuxième chargement, le cadre est fermé ; Recharger le rouvre', async () => {
  setup(<OngletArtefacts topicId="tp_1" />, snapshot(), '/', {
    [LISTE]: json(200, reponse([artefact('rapport.html', 'html')])),
    [LIEN]: liens(),
  });
  await userEvent.click(await screen.findByRole('button', { name: /rapport\.html/ }));
  const cadre = await screen.findByTitle('Artefact rapport.html');
  fireEvent.load(cadre);
  expect(screen.getByTitle('Artefact rapport.html')).toBeTruthy();
  fireEvent.load(cadre);
  expect(
    await screen.findByText(
      'L’artefact a quitté sa page : cadre fermé. Recharger pour le rouvrir.',
    ),
  ).toBeTruthy();
  expect(document.querySelector('iframe')).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Recharger' }));
  const rouvert = await screen.findByTitle('Artefact rapport.html');
  fireEvent.load(rouvert);
  expect(screen.getByTitle('Artefact rapport.html')).toBeTruthy();
});

test('port indisponible : dit pourquoi, aucun lien demandé, le Markdown reste lisible', async () => {
  const h = setup(<OngletArtefacts topicId="tp_1" />, snapshot(), '/', {
    [LISTE]: json(
      200,
      reponse([artefact('rapport.html', 'html'), artefact('notes.md', 'md')], {
        disponible: false,
        port: 4880,
        raison: 'le port 4880 est occupé',
      } as never),
    ),
    'GET /api/topics/tp_1/files/content?path=notes.md': json(200, { content: 'Lisible.' }),
  });
  expect(
    await screen.findByText(/Port des artefacts 4880 indisponible : le port 4880 est occupé/),
  ).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: /rapport\.html/ }));
  expect(document.querySelector('iframe')).toBeNull();
  expect((screen.getByRole('button', { name: 'Recharger' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect(h.calls.some((c) => c.url.endsWith('/artefacts/lien'))).toBe(false);
  await userEvent.click(screen.getByRole('button', { name: /notes\.md/ }));
  expect(await screen.findByText('Lisible.')).toBeTruthy();
});

const panneau = () => (
  <PanneauContexte
    namespace="aid"
    topicSlug="s"
    topicId="tp_1"
    base="main"
    remote={null}
    activeAgentId={null}
  />
);

test('l’onglet Artefacts suit Fichiers, et n’existe pas pour un agent distant', async () => {
  setup(panneau(), snapshot());
  const onglets = (await screen.findAllByRole('tab')).map((t) => t.textContent);
  expect(onglets.slice(0, 5)).toEqual(['Sujet', 'Git', 'Fichiers', 'Artefacts', 'Livraison']);
  expect(screen.getByRole('tab', { name: 'Artefacts' }).getAttribute('data-node')).toBe(
    '1-3.onglets.artefacts',
  );
  cleanup();
  setup(
    <AgentRoutesContext.Provider value={routesDistantes({ serveur: 'srv', injoignable: false })}>
      {panneau()}
    </AgentRoutesContext.Provider>,
    snapshot(),
  );
  expect(await screen.findByRole('tab', { name: 'Fichiers' })).toBeTruthy();
  expect(screen.queryByRole('tab', { name: 'Artefacts' })).toBeNull();
});

test('D168 : Fichiers ouvre un .html dans Artefacts, même sans statut git', async () => {
  setup(panneau(), snapshot(), '/', {
    'GET /api/topics/tp_1/files?scope=tout': json(200, {
      tree: [{ name: 'vieux.html', path: 'vieux.html', kind: 'file', status: '' }],
      total: 1,
      modified: 0,
      truncated: false,
    }),
    'GET /api/topics/tp_1/files/content?path=vieux.html': json(200, { content: '<p>v</p>' }),
    [LISTE]: json(200, reponse([])),
    [LIEN]: liens(),
  });
  await userEvent.click(await screen.findByRole('tab', { name: 'Fichiers' }));
  await userEvent.click(await screen.findByRole('treeitem', { name: /vieux\.html/ }));
  await userEvent.click(await screen.findByRole('button', { name: 'Ouvrir dans Artefacts' }));
  const onglet = screen.getByRole('tab', { name: 'Artefacts' });
  expect(onglet.getAttribute('aria-selected')).toBe('true');
  expect(document.activeElement).toBe(onglet);
  const cadre = await screen.findByTitle('Artefact vieux.html');
  expect(cadre.getAttribute('src')).toBe(URL_1);
  expect(screen.getByRole('button', { name: /vieux\.html/ }).getAttribute('aria-current')).toBe(
    'true',
  );
});

test('D168 : pas de renvoi pour un fichier d’un autre type', async () => {
  setup(panneau(), snapshot(), '/', {
    'GET /api/topics/tp_1/files?scope=tout': json(200, {
      tree: [{ name: 'a.ts', path: 'a.ts', kind: 'file', status: 'M' }],
      total: 1,
      modified: 1,
      truncated: false,
    }),
    'GET /api/topics/tp_1/files/content?path=a.ts': json(200, { content: 'x' }),
  });
  await userEvent.click(await screen.findByRole('tab', { name: 'Fichiers' }));
  await userEvent.click(await screen.findByRole('treeitem', { name: /a\.ts/ }));
  await screen.findByRole('button', { name: 'Ouvrir dans l’éditeur' });
  expect(screen.queryByRole('button', { name: 'Ouvrir dans Artefacts' })).toBeNull();
});
