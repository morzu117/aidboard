// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { EcrireAuMesh } from '../../web/src/ui/EcrireAuMesh.js';
import { SansCarteSwairm } from '../../web/src/ui/SwairmBoard.js';
import { AVERTISSEMENT_CREATION } from '../../src/shared/ecritures.js';
import { FakeSocket, json, setup, snapshot } from './helpers.js';

const date = '2026-11-15T10:00:00Z';
const ok = <T,>(data: T) => ({ ok: true, data, readAt: date, schemaVersion: null });
const ligne = 'Swairm: exemple/depot#41';
const sujet = {
  projet: 'exemple/depot',
  id: '41',
  titre: '<b>Un sujet</b>',
  etat: 'planned',
  colonne: 'travail',
  en_pause: false,
  pas: { total: 0, par_etat: {} },
  maj: date,
  vol: null,
  carte: null,
  conflit: [],
};
function etat(proxyConfigure = true, ecritures = true) {
  return snapshot({
    mesh: {
      state: {
        proxyConfigure,
        ecritures,
        superviseur: null,
        connected: true,
        tailscale: 'running',
        monitor: 'running',
        pending: 0,
        since: null,
        cell: 'cell-test',
      },
      inbox: [],
      tailscaleManage: false,
    },
  });
}
const routes = {
  'GET /api/board/projects': json(
    200,
    ok([
      { id: 17, title: 'Projet exemple', slug: 'exemple', status: 'active', author: 'cell-test' },
    ]),
  ),
  'GET /api/swairm/board': json(200, {
    sujets: [sujet],
    cartes: [],
    board: ok({ cards: [], due: [], searched: 0 }),
    swairm: { etat: 'ok', data: { projets: [], erreurs: [] } },
  }),
  'GET /api/swarph/cartes-en-vol?mesh=principal': json(200, []),
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test.each([
  [false, false, "n'est pas configuré"],
  [true, false, 'lecture seule'],
  [true, true, ''],
] as const)('bouton avec proxy %s, écritures %s', async (proxy, ecritures, raison) => {
  const h = setup(<SansCarteSwairm />, etat(proxy, ecritures), '/', routes);
  await waitFor(() => expect(h.client).toBeTruthy());
  await waitFor(() => expect(FakeSocket.all.length).toBeGreaterThan(0));
  act(() => FakeSocket.all[0]!.open());
  fireEvent.click(await screen.findByText('Sujets Swairm sans carte (1)'));
  const bouton = screen.getByRole('button', { name: 'Créer la carte' });
  await waitFor(() => expect(bouton).toHaveProperty('disabled', !ecritures));
  if (raison) expect(bouton.title).toContain(raison);
  else {
    fireEvent.click(bouton);
    expect(await screen.findByRole('textbox', { name: 'Titre' })).toHaveProperty(
      'value',
      sujet.titre,
    );
  }
});

test('projet sans défaut, ligne fixe, titre modifiable et paramètres complets', async () => {
  const h = setup(
    <EcrireAuMesh
      mesh="principal"
      action="carte.creer"
      valeurs={{ titre: sujet.titre, ligneSwairm: ligne }}
      onClose={() => {}}
    />,
    etat(),
    '/',
    {
      ...routes,
      'POST /api/swarph/ecrire/apercu': json(200, {
        ok: true,
        aBlanc: true,
        argv: [],
        resume: 'Création de carte dans le projet #17',
        texte: ligne,
        rappel: null,
      }),
    },
  );
  await waitFor(() => expect(FakeSocket.all.length).toBeGreaterThan(0));
  act(() => FakeSocket.all[0]!.open());
  const choix = await screen.findByRole('combobox', { name: 'Projet' });
  expect(choix).toHaveProperty('value', '');
  const bouton = screen.getByRole('button', { name: "Voir l'aperçu" });
  expect(bouton).toHaveProperty('disabled', true);
  expect(screen.getByText(ligne).tagName).toBe('P');
  expect(screen.queryByRole('textbox', { name: /Swairm/ })).toBeNull();
  await screen.findByRole('option', { name: 'Projet exemple (#17)' });
  fireEvent.change(choix, { target: { value: '17' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Titre' }), {
    target: { value: 'Autre titre' },
  });
  fireEvent.change(screen.getByRole('textbox', { name: 'Texte facultatif' }), {
    target: { value: 'Du texte' },
  });
  fireEvent.click(bouton);
  expect(await screen.findByText(AVERTISSEMENT_CREATION)).toBeTruthy();
  expect(h.calls.find((c) => c.url === '/api/swarph/ecrire/apercu')?.body).toEqual({
    mesh: 'principal',
    action: 'carte.creer',
    params: {
      projet: 17,
      projetNom: 'Projet exemple',
      titre: 'Autre titre',
      corps: `${ligne}\n\nDu texte`,
    },
  });
  expect(screen.queryByRole('button', { name: 'Copier la commande' })).toBeNull();
});

test('création verrouillée pendant la relecture, même si elle échoue', async () => {
  const h = setup(<SansCarteSwairm />, etat(), '/', {
    ...routes,
    'GET /api/swarph/cartes-en-vol?mesh=principal': json(200, [
      { ligne_swairm: ligne, etat: 'incertain' },
    ]),
    'POST /api/swarph/cartes-en-vol/relire': json(200, { ok: false }),
  });
  await waitFor(() => expect(h.client).toBeTruthy());
  await waitFor(() => expect(FakeSocket.all.length).toBeGreaterThan(0));
  act(() => FakeSocket.all[0]!.open());
  fireEvent.click(await screen.findByText('Sujets Swairm sans carte (1)'));
  const relire = await screen.findByRole('button', { name: 'Relire le board' });
  expect(screen.getByRole('button', { name: 'Créer la carte' })).toHaveProperty('disabled', true);
  fireEvent.click(relire);
  expect(relire).toHaveProperty('disabled', true);
  await screen.findByText('Relecture du board impossible. Réessaie.');
  expect(screen.getByRole('button', { name: 'Créer la carte' })).toHaveProperty('disabled', true);
  expect(h.calls.find((c) => c.method === 'POST')?.body).toEqual({ mesh: 'principal', ligne });
});

test.each(['succes', 'echec', 'attente'] as const)(
  'résultat du téléphone : %s, message du daemon et suite',
  async (issue) => {
    const incertain = issue !== 'succes';
    const envoye = vi.fn();
    const relire = vi.fn();
    const message =
      issue === 'attente'
        ? 'Création incertaine : A-I-D relira le board dans une minute.'
        : incertain
          ? 'Création incertaine : relire le board.'
          : 'Carte créée : #81.';
    const h = setup(
      <EcrireAuMesh
        mesh="principal"
        action="carte.creer"
        valeurs={{ titre: 'Un sujet', ligneSwairm: ligne }}
        onClose={() => {}}
        onEnvoye={envoye}
        onRelire={relire}
      />,
      etat(),
      '/',
      {
        ...routes,
        'POST /api/swarph/ecrire/apercu': json(200, {
          ok: true,
          aBlanc: true,
          argv: [],
          resume: 'Création de carte dans le projet #17',
          texte: ligne,
          rappel: null,
        }),
        'POST /api/swarph/ecrire/envoyer': json(202, { confirmation: 'creation-test' }),
        'GET /api/confirmations': json(200, {
          ouvertes: [],
          recentes: [
            {
              id: 'creation-test',
              classe: 'toujours',
              etat: 'acceptee',
              resultat: incertain ? 'echouee' : 'executee',
              envoi: {
                code: incertain ? 'upstream_ambiguous' : 'succes',
                message:
                  issue === 'attente'
                    ? 'Création incertaine : la carte a peut-être été créée.'
                    : message,
                id: incertain ? undefined : 81,
                relecture: incertain ? issue : undefined,
                enVol: incertain,
                cree: !incertain,
                open_obligations: [],
              },
            },
          ],
        }),
      },
    );
    await waitFor(() => expect(FakeSocket.all.length).toBeGreaterThan(0));
    act(() => FakeSocket.all[0]!.open());
    await screen.findByRole('option', { name: 'Projet exemple (#17)' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Projet' }), { target: { value: '17' } });
    fireEvent.click(screen.getByRole('button', { name: "Voir l'aperçu" }));
    fireEvent.click(await screen.findByRole('button', { name: 'Envoyer' }));
    await screen.findByText(message, { exact: false });
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.queryByText('Exécutée')).toBeNull();
    expect(screen.queryByText('Le board a été relu : aucune carte ne porte ce sujet.')).toBeNull();
    expect(h.calls.find((c) => c.url === '/api/swarph/ecrire/envoyer')?.body).toEqual({
      mesh: 'principal',
      action: 'carte.creer',
      params: { projet: 17, projetNom: 'Projet exemple', titre: 'Un sujet', corps: ligne },
    });
    if (incertain) {
      expect(envoye).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Relire le board' }));
      expect(relire).toHaveBeenCalledOnce();
    } else expect(envoye).toHaveBeenCalledOnce();
  },
);

test('succès : relecture fraîche du board et sujet désormais relié', async () => {
  const h = setup(<SansCarteSwairm />, etat(), '/', {
    ...routes,
    'POST /api/swarph/ecrire/apercu': json(200, {
      ok: true,
      aBlanc: true,
      argv: [],
      resume: 'Création de carte dans le projet #17',
      texte: ligne,
      rappel: null,
    }),
    'POST /api/swarph/ecrire/envoyer': json(200, {
      code: 'succes',
      id: 81,
      message: 'Carte créée.',
      open_obligations: [],
    }),
    'GET /api/swairm/board?fresh=1': json(200, {
      sujets: [{ ...sujet, carte: 81 }],
      cartes: [],
      board: ok({ cards: [], due: [], searched: 0 }),
      swairm: { etat: 'ok', data: { projets: [], erreurs: [] } },
    }),
  });
  await waitFor(() => expect(FakeSocket.all.length).toBeGreaterThan(0));
  act(() => FakeSocket.all[0]!.open());
  fireEvent.click(await screen.findByText('Sujets Swairm sans carte (1)'));
  const bouton = screen.getByRole('button', { name: 'Créer la carte' });
  await waitFor(() => expect(bouton).toHaveProperty('disabled', false));
  fireEvent.click(bouton);
  await screen.findByRole('option', { name: 'Projet exemple (#17)' });
  fireEvent.change(screen.getByRole('combobox', { name: 'Projet' }), { target: { value: '17' } });
  fireEvent.click(screen.getByRole('button', { name: "Voir l'aperçu" }));
  fireEvent.click(await screen.findByRole('button', { name: 'Envoyer' }));
  await screen.findByText('Carte créée.', { exact: false });
  const dialogue = within(screen.getByRole('dialog'));
  expect(dialogue.getByRole('status').textContent).toContain('Carte : #81');
  expect(dialogue.getAllByRole('status')).toHaveLength(1);
  await screen.findByText('Sujets Swairm sans carte (0)');
  expect(h.calls.some((c) => c.url === '/api/swairm/board?fresh=1')).toBe(true);
});

test('relecture réussie sans carte : le bouton redevient disponible', async () => {
  let vols = [{ ligne_swairm: ligne }];
  setup(<SansCarteSwairm />, etat(), '/', {
    ...routes,
    'GET /api/swarph/cartes-en-vol?mesh=principal': () => json(200, vols)(),
    'POST /api/swarph/cartes-en-vol/relire': () => {
      vols = [];
      return json(200, { ok: true, id: null })();
    },
    'GET /api/swairm/board?fresh=1': routes['GET /api/swairm/board'],
  });
  await waitFor(() => expect(FakeSocket.all.length).toBeGreaterThan(0));
  act(() => FakeSocket.all[0]!.open());
  fireEvent.click(await screen.findByText('Sujets Swairm sans carte (1)'));
  fireEvent.click(await screen.findByRole('button', { name: 'Relire le board' }));
  await screen.findByText('Board relu.');
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Créer la carte' })).toHaveProperty(
      'disabled',
      false,
    ),
  );
});

test.each([
  [false, "n'est pas configuré"],
  [true, 'lecture seule'],
] as const)(
  'raison de désactivation unique en tête de section, proxy configuré %s',
  async (proxy, raison) => {
    setup(<SansCarteSwairm />, etat(proxy, false), '/', {
      ...routes,
      'GET /api/swairm/board': json(200, {
        sujets: [sujet, { ...sujet, id: '42' }],
        cartes: [],
        board: ok({ cards: [], due: [], searched: 0 }),
        swairm: { etat: 'ok', data: { projets: [], erreurs: [] } },
      }),
    });
    await waitFor(() => expect(FakeSocket.all.length).toBeGreaterThan(0));
    act(() => FakeSocket.all[0]!.open());
    fireEvent.click(await screen.findByText('Sujets Swairm sans carte (2)'));
    const messages = screen.getAllByText(new RegExp(raison));
    expect(messages).toHaveLength(1);
    expect(messages[0]!.closest('li')).toBeNull();
    for (const bouton of screen.getAllByRole('button', { name: 'Créer la carte' })) {
      expect(bouton).toHaveProperty('disabled', true);
      expect(bouton.title).toContain(raison);
    }
  },
);

test('relecture manuelle en attente : message de grâce et bouton toujours verrouillé', async () => {
  setup(<SansCarteSwairm />, etat(), '/', {
    ...routes,
    'GET /api/swarph/cartes-en-vol?mesh=principal': json(200, [{ ligne_swairm: ligne }]),
    'POST /api/swarph/cartes-en-vol/relire': json(200, { ok: true, id: null, attente: true }),
  });
  await waitFor(() => expect(FakeSocket.all.length).toBeGreaterThan(0));
  act(() => FakeSocket.all[0]!.open());
  fireEvent.click(await screen.findByText('Sujets Swairm sans carte (1)'));
  fireEvent.click(await screen.findByRole('button', { name: 'Relire le board' }));
  await screen.findByText('Création incertaine : A-I-D relira le board dans une minute.');
  expect(screen.queryByText('Board relu.')).toBeNull();
  expect(screen.getByRole('button', { name: 'Créer la carte' })).toHaveProperty('disabled', true);
});
