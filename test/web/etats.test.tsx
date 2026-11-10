// @vitest-environment jsdom
import { createHash, webcrypto } from 'node:crypto';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { parseGraph, parseObligations } from '../../src/shared/board.js';
import {
  actionsPossibles,
  confirmationEtatRequise,
  envoyerEtat,
} from '../../web/src/data/etats.js';
import { AidApiError } from '../../web/src/data/api.js';
import { AidClient } from '../../web/src/data/client.js';
import { ChangerEtat } from '../../web/src/ui/ChangerEtat.js';
import { json, setup, snapshot } from './helpers.js';

const obligation = (champs = {}) =>
  parseObligations({
    obligations: [
      {
        id: 81,
        step: 'build',
        status: 'open',
        holder: 'peer-a',
        ...champs,
      },
    ],
  })!.value.obligations[0]!;
const etape = (champs = {}) =>
  parseGraph({ steps: [{ step: 'build', eligible: ['peer-a'], mandatory: false, ...champs }] })!
    .value.steps[0]!;
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test.each([
  [{}, etape(), ['prendre', 'refuser', 'clore']],
  [{ holder: null }, etape(), ['prendre', 'refuser']],
  [{ holder: null }, etape({ eligible: ['peer-b'] }), []],
  [{ holder: null }, undefined, []],
  [{ holder: 'peer-b' }, etape(), []],
  [{ taken_at: '2026-01-01' }, etape(), ['clore']],
  [{ conditions: [{ id: 'c1' }] }, etape(), ['prendre', 'refuser', 'clore']],
  [{ unclosable_reason: 'bloquée' }, etape(), ['prendre', 'refuser']],
  [{ status: 'closed' }, etape(), []],
  [{ status: 'fallback_fired' }, etape(), []],
  [{ status: 'withdrawn' }, etape(), []],
  [{}, undefined, ['prendre', 'refuser', 'clore']],
])('actions selon la lecture %j', (champs, step, attendu) => {
  expect(actionsPossibles(obligation(champs), step, 'peer-a')).toEqual(attendu);
});

test('lecture tolérante des nouveaux champs', () => {
  expect(etape({ eligible: 12 }).eligible).toEqual([]);
  expect(etape({ eligible: ['peer-a', 12] }).eligible).toEqual(['peer-a']);
  expect(obligation()).toMatchObject({
    takenAt: null,
    accept: null,
    unclosableReason: null,
    conditions: [],
  });
  expect(
    obligation({
      accept: 'texte ',
      conditions: ['c1'],
      taken_at: 'date',
      unclosable_reason: 'raison',
    }),
  ).toMatchObject({
    accept: 'texte ',
    conditions: ['c1'],
    takenAt: 'date',
    unclosableReason: 'raison',
  });
});

function ouvrir(champs = {}, mesh = true) {
  const relire = vi.fn();
  const h = setup(
    <ChangerEtat obligation={obligation(champs)} etape={etape()} carte={1457} relire={relire} />,
    snapshot(
      mesh
        ? {
            mesh: {
              state: {
                cell: 'peer-a',
                ecritures: true,
                proxyConfigure: true,
                superviseur: null,
                connected: true,
                tailscale: 'running',
                monitor: 'running',
                pending: 0,
                since: null,
              },
              inbox: [],
              tailscaleManage: false,
            },
          }
        : {},
    ),
  );
  h.respond.set(
    'POST /api/swarph/etat/envoyer',
    json(200, { code: 'succes', open_obligations: [] }),
  );
  return { ...h, relire };
}
const envois = (h: ReturnType<typeof ouvrir>) =>
  h.calls.filter((c) => c.url === '/api/swarph/etat/envoyer');

test.each(['Prendre', 'Refuser'])('confirmation locale : %s', async (nom) => {
  const h = ouvrir();
  fireEvent.click(await screen.findByRole('button', { name: nom }));
  expect(screen.getByRole('dialog').textContent).toContain(`${nom} l'obligation #81 ?`);
  expect(envois(h)).toHaveLength(0);
  if (nom === 'Refuser') {
    expect(screen.getByRole('button', { name: 'Confirmer' })).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByLabelText('Motif'), { target: { value: 'Motif confidentiel' } });
  }
  fireEvent.click(screen.getByRole('button', { name: 'Confirmer' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirmer' }));
  await screen.findByText('Parti.');
  expect(envois(h)).toHaveLength(1);
  expect(envois(h)[0]!.body).toEqual({
    action: `obligation.${nom === 'Prendre' ? 'prendre' : 'refuser'}`,
    params: {
      carte: 1457,
      obligation: 81,
      attendu: { status: 'open' },
      ...(nom === 'Refuser' && { motif: 'Motif confidentiel' }),
    },
  });
  expect(h.relire).toHaveBeenCalledOnce();
});

test.each(['<img src=x onerror=alert(1)> https://example.com', 'Accept fixé '])(
  'clôture : accept brut et hash exact %s',
  async (accept) => {
    vi.stubGlobal('crypto', webcrypto);
    const h = ouvrir({ accept });
    fireEvent.click(await screen.findByRole('button', { name: 'Clore' }));
    const dialogue = screen.getByRole('dialog');
    expect(dialogue.querySelector('pre')!.textContent).toBe(accept);
    expect(dialogue.querySelector('img, a')).toBeNull();
    expect(
      [...screen.getByLabelText('Issue').querySelectorAll('option')].map((o) => o.value),
    ).toEqual(['pass', 'fail', 'cannot_evaluate', 'skipped']);
    fireEvent.change(screen.getByLabelText('Preuve'), {
      target: { value: 'preuve confidentielle' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmer' }));
    const resultat = await screen.findByText('Parti.');
    expect(resultat.textContent).not.toContain('preuve confidentielle');
    expect(envois(h)[0]!.body).toEqual({
      action: 'obligation.clore',
      params: {
        carte: 1457,
        obligation: 81,
        attendu: {
          status: 'open',
          acceptSha256: createHash('sha256').update(accept).digest('hex'),
        },
        issue: 'pass',
        preuve: 'preuve confidentielle',
      },
    });
  },
);

test.each([
  [409, { error: 'perime' }],
  [200, { code: 'upstream_error', status: 409, open_obligations: [] }],
])('état périmé %s : relecture sans réessai', async (status, corps) => {
  const h = ouvrir();
  h.respond.set('POST /api/swarph/etat/envoyer', json(status, corps));
  fireEvent.click(await screen.findByRole('button', { name: 'Prendre' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirmer' }));
  await screen.findByText(
    "L'obligation a changé juste avant l'écriture. Rien n'a été modifié. Relis la carte.",
  );
  expect(h.relire).toHaveBeenCalledOnce();
  expect(screen.queryByRole('button', { name: 'Réessayer' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Confirmer' })).toHaveProperty('disabled', true);
});

test.each(['upstream_ambiguous', 'delai', 'interrompu', 'format'])(
  'envoi incertain %s',
  async (code) => {
    const h = ouvrir();
    h.respond.set('POST /api/swarph/etat/envoyer', json(200, { code, open_obligations: [] }));
    fireEvent.click(await screen.findByRole('button', { name: 'Prendre' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirmer' }));
    await screen.findByText(/Envoi incertain/);
    expect(screen.queryByRole('button', { name: 'Réessayer' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Relire la carte' }));
    expect(h.relire).toHaveBeenCalledTimes(2);
  },
);

test('confirmation du téléphone puis envoi et relecture', async () => {
  const h = ouvrir();
  h.respond.set('POST /api/swarph/etat/envoyer', json(202, { confirmation: 'etat-test' }));
  h.respond.set(
    'GET /api/confirmations',
    json(200, {
      ouvertes: [],
      recentes: [
        {
          id: 'etat-test',
          classe: 'defaut',
          etat: 'consommee',
          resultat: 'executee',
          envoi: { code: 'succes', open_obligations: [], preuve: 'jamais affichée' },
        },
      ],
    }),
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Prendre' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirmer' }));
  await screen.findByText('Parti.');
  expect(screen.getByText('Exécutée')).toBeTruthy();
  expect(screen.queryByText('jamais affichée')).toBeNull();
  expect(h.relire).toHaveBeenCalledOnce();
});

test.each([
  [
    409,
    { error: 'confirmation_requise' },
    /^La porte des confirmations n'est pas armée : arme-la depuis ton téléphone pour changer un état\. Rien n'est parti\.$/,
  ],
  [409, { error: 'proxy_absent' }, /proxy.*pas configuré/],
  [409, { error: 'confirmation_impossible', message: 'Téléphone requis' }, /Téléphone requis/],
  [400, { error: 'schema', message: 'Paramètres invalides' }, /Paramètres invalides/],
  [422, { error: 'nettoyage', message: 'Preuve refusée' }, /Preuve refusée/],
] as const)('refus %s', async (status, corps, message) => {
  const h = ouvrir();
  h.respond.set('POST /api/swarph/etat/envoyer', json(status, corps));
  fireEvent.click(await screen.findByRole('button', { name: 'Prendre' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirmer' }));
  expect((await screen.findByRole('alert')).textContent).toMatch(message);
});

test('aucun bouton sans mesh', () => {
  ouvrir({}, false);
  expect(screen.queryByRole('button')).toBeNull();
});

test('envoyerEtat conserve les erreurs HTTP du client', async () => {
  const client = new AidClient({ fetchImpl: async () => json(409, { error: 'perime' })() });
  await expect(
    envoyerEtat(
      'obligation.prendre',
      { carte: 1, obligation: 81, attendu: { status: 'open' } },
      client,
    ),
  ).rejects.toBeInstanceOf(AidApiError);
});

test('D275 levé : une obligation à conditions se clôt avec preuves et skipped', async () => {
  vi.stubGlobal('crypto', webcrypto);
  const h = ouvrir({ conditions: [{ id: 'c1' }, { id: 'c2' }], accept: 'Conditions' });
  fireEvent.click(await screen.findByRole('button', { name: 'Clore' }));
  expect(screen.getByRole('button', { name: 'Confirmer' })).toHaveProperty('disabled', true);
  fireEvent.change(screen.getByLabelText('Issue'), { target: { value: 'skipped' } });
  fireEvent.change(screen.getByLabelText('Preuve c1'), { target: { value: 'Première preuve' } });
  expect(screen.getByRole('button', { name: 'Confirmer' })).toHaveProperty('disabled', true);
  fireEvent.change(screen.getByLabelText('Preuve c2'), { target: { value: 'Seconde preuve' } });
  fireEvent.click(screen.getByRole('button', { name: 'Confirmer' }));
  await screen.findByText('Parti.');
  expect(envois(h)[0]!.body).toMatchObject({
    action: 'obligation.clore',
    params: { issue: 'skipped', preuves: { c1: 'Première preuve', c2: 'Seconde preuve' } },
  });
  expect((envois(h)[0]!.body as { params: object }).params).not.toHaveProperty('preuve');
});

test('D283 : envoyerEtat reconnaît le 409 lecture seule', async () => {
  const client = new AidClient({
    fetchImpl: async () => json(409, { error: 'proxy_lecture_seule' })(),
  });
  expect(
    await envoyerEtat(
      'obligation.prendre',
      { carte: 42, obligation: 81, attendu: { status: 'open' } },
      client,
    ),
  ).toEqual({ code: 'proxy_lecture_seule' });
});

test('D283 : le dialogue traduit le 409 lecture seule', async () => {
  const h = ouvrir();
  h.respond.set('POST /api/swarph/etat/envoyer', json(409, { error: 'proxy_lecture_seule' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Prendre' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirmer' }));
  expect(
    await screen.findByText('Le proxy de ta cellule est en lecture seule : rien ne peut partir.'),
  ).toBeTruthy();
});

test('envoyerEtat reconnaît la confirmation requise sans relancer', async () => {
  const fetchImpl = vi.fn(async () => json(409, { error: 'confirmation_requise' })());
  const client = new AidClient({ fetchImpl });
  const erreur = await envoyerEtat(
    'obligation.prendre',
    { carte: 1, obligation: 81, attendu: { status: 'open' } },
    client,
  ).catch((e: unknown) => e);
  expect(confirmationEtatRequise(erreur)).toBe(true);
  expect(confirmationEtatRequise(new AidApiError(409, 'perime', { error: 'perime' }))).toBe(false);
  expect(fetchImpl).toHaveBeenCalledOnce();
});

test('D276 : le compteur Python bloque au-delà de 12 000, y compris hors ASCII', async () => {
  const h = ouvrir({ conditions: [{ id: 'a' }] });
  fireEvent.click(await screen.findByRole('button', { name: 'Clore' }));
  const champ = screen.getByLabelText('Preuve a');
  expect(champ).toHaveProperty('maxLength', 12000);
  fireEvent.change(champ, { target: { value: 'x'.repeat(11991) } });
  expect(screen.getByText('12000 / 12 000 caractères sérialisés')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Confirmer' })).toHaveProperty('disabled', false);
  fireEvent.change(champ, { target: { value: 'x'.repeat(11992) } });
  expect(screen.getByRole('button', { name: 'Confirmer' })).toHaveProperty('disabled', true);
  fireEvent.change(champ, { target: { value: '😀'.repeat(1000) } });
  expect(screen.getByText('12009 / 12 000 caractères sérialisés')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Confirmer' })).toHaveProperty('disabled', true);
  expect(envois(h)).toHaveLength(0);
});

test('clôture : 413 demande_trop_grande expliqué sans nouvelle demande', async () => {
  vi.stubGlobal('crypto', webcrypto);
  const h = ouvrir();
  h.respond.set('POST /api/swarph/etat/envoyer', json(413, { error: 'demande_trop_grande' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Clore' }));
  expect(screen.getByLabelText('Preuve')).toHaveProperty('maxLength', 3900);
  fireEvent.change(screen.getByLabelText('Preuve'), { target: { value: 'Une preuve' } });
  fireEvent.click(screen.getByRole('button', { name: 'Confirmer' }));
  expect((await screen.findByRole('alert')).textContent).toBe(
    "Trop long pour être confirmé au téléphone : raccourcis la preuve. Rien n'est parti.",
  );
  expect(envois(h)).toHaveLength(1);
  expect(screen.queryByText('En attente de ta confirmation sur le téléphone.')).toBeNull();
});
