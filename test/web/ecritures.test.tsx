// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import {
  argvEcriture,
  type ActionEcriture,
  type ParametresEcriture,
} from '../../src/shared/ecritures.js';
import type { ApercuEcriture } from '../../web/src/data/ecritures.js';
import { EcrireAuMesh } from '../../web/src/ui/EcrireAuMesh.js';
import { Swarph } from '../../web/src/ecrans/Swarph.js';
import { Boite } from '../../web/src/ecrans/Boite.js';
import { json, setup, snapshot } from './helpers.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const texte = '<b>Texte exact</b>\n**sans Markdown**';
const mesh = {
  state: {
    connected: false,
    tailscale: 'running' as const,
    monitor: 'stopped' as const,
    pending: 0,
    since: null,
    cell: 'cell-test',
  },
  inbox: [],
  tailscaleManage: false,
};
function ouvrir(action: ActionEcriture = 'dm.envoyer', reponse?: ApercuEcriture) {
  const params = {
    'carte.note': { carte: 101, a: null, kind: 'fyi', texte },
    'dm.envoyer': { pair: 'pair-test', fil: null, kind: 'fyi', texte },
    'canal.poster': { canal: 'canal-test', kind: 'fyi', texte },
  } satisfies ParametresEcriture;
  const resultat: ApercuEcriture = reponse ?? {
    ok: true,
    aBlanc: true,
    argv: argvEcriture(action, params[action], 'cell-test'),
    resume: 'Résumé de l’écriture',
    texte,
    rappel: null,
  };
  const fermer = vi.fn();
  const h = setup(
    <EcrireAuMesh
      action={action}
      valeurs={{ texte, carte: 101, pair: 'pair-test', canal: 'canal-test' }}
      onClose={fermer}
    />,
    snapshot(),
    '/',
    {
      'POST /api/swarph/ecrire/apercu': json(200, resultat),
    },
  );
  return { ...h, resultat, fermer };
}
async function voir() {
  await userEvent.click(screen.getByRole('button', { name: "Voir l'aperçu" }));
}

test.each(['carte.note', 'dm.envoyer', 'canal.poster'] as const)(
  'aperçu %s : commande et texte bruts, aucun envoi',
  async (action) => {
    const h = ouvrir(action);
    expect(h.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    await voir();
    await screen.findByText('Résumé de l’écriture');
    expect(
      h.resultat.ok && screen.getByText(['swarph', ...h.resultat.argv].join(' ')),
    ).toBeTruthy();
    expect(
      document.querySelector('section[aria-label="Aperçu"] pre:last-of-type')?.textContent,
    ).toBe(texte);
    expect(document.querySelector('section[aria-label="Aperçu"] b')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Envoyer' })).toBeNull();
    expect(h.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    const appel = h.calls.find((c) => c.method === 'POST');
    expect(appel?.body).toMatchObject({ action, params: { texte, kind: 'fyi' } });
    await userEvent.click(screen.getByRole('button', { name: 'Fermer' }));
    expect(h.fermer).toHaveBeenCalledOnce();
  },
);

test.each(['schema', 'nettoyage'] as const)('refus %s sans texte dans le message', async (kind) => {
  ouvrir('dm.envoyer', {
    ok: false,
    kind,
    message: kind === 'schema' ? 'nom de pair invalide' : 'Adresse privée détectée',
  });
  await voir();
  const alerte = await screen.findByRole('alert');
  expect(alerte.textContent).toBe(
    kind === 'schema' ? 'nom de pair invalide' : 'Adresse privée détectée',
  );
  expect(alerte.textContent).not.toContain(texte);
  expect(screen.queryByRole('region', { name: 'Aperçu' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Copier la commande' })).toBeNull();
});

test('rappel de toutes les obligations, non bloquant', async () => {
  ouvrir('carte.note', {
    ok: true,
    aBlanc: true,
    argv: [],
    resume: 'Note',
    texte,
    rappel: { obligations: [12, 34] },
  });
  await voir();
  for (const n of [12, 34])
    expect(
      await screen.findByText(
        `Tu as l'obligation #${n} ouverte sur cette carte. Cette note ne la clôt pas ; la clore passe par le 36.`,
      ),
    ).toBeTruthy();
});
test('rappel indisponible', async () => {
  ouvrir('carte.note', {
    ok: true,
    aBlanc: true,
    argv: [],
    resume: 'Note',
    texte,
    rappel: { indisponible: true },
  });
  await voir();
  expect(await screen.findByText('Rappel des obligations indisponible.')).toBeTruthy();
});

test('copie exacte, citation shell des espaces et apostrophes, confirmation', async () => {
  const utilisateur = userEvent.setup();
  const copier = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  ouvrir('dm.envoyer', {
    ok: true,
    aBlanc: true,
    argv: ['mesh', 'send', "nom avec l’espace'", '--content-file', 'FICHIER'],
    resume: 'DM',
    texte,
    rappel: null,
  });
  await voir();
  const commande = `swarph mesh send 'nom avec l’espace'"'"'' --content-file FICHIER`;
  expect(await screen.findByText(commande)).toBeTruthy();
  expect(copier).not.toHaveBeenCalled();
  await utilisateur.click(screen.getByRole('button', { name: 'Copier la commande' }));
  expect(copier).toHaveBeenLastCalledWith(commande);
  expect(await screen.findByRole('status')).toHaveProperty('textContent', 'Copié');
  await utilisateur.click(screen.getByRole('button', { name: 'Copier le texte' }));
  expect(copier).toHaveBeenLastCalledWith(texte);
  expect(await screen.findByRole('status')).toHaveProperty('textContent', 'Copié');
});

test('presse-papiers refusé', async () => {
  const utilisateur = userEvent.setup();
  vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('refus'));
  ouvrir();
  await voir();
  await screen.findByText('Résumé de l’écriture');
  await utilisateur.click(screen.getByRole('button', { name: 'Copier la commande' }));
  expect((await screen.findByRole('alert')).textContent).toContain('presse-papiers refusé');
  expect(screen.queryByText('Copié')).toBeNull();
});

test.each(['Texte', 'Kind', 'Pair'])('modifier %s efface l’aperçu', async (champ) => {
  ouvrir();
  await voir();
  await screen.findByText('Résumé de l’écriture');
  fireEvent.change(screen.getByLabelText(champ), {
    target: { value: champ === 'Kind' ? 'answer' : 'autre' },
  });
  expect(screen.queryByText('Résumé de l’écriture')).toBeNull();
});

test('Swarph : absent sans mesh, choix DM ou canal avec champs vides', async () => {
  setup(<Swarph />, snapshot());
  await screen.findByText('Connecter cet A-I-D à swarph');
  expect(screen.queryByRole('button', { name: 'Écrire au mesh (à blanc)' })).toBeNull();
  cleanup();
  setup(<Swarph />, snapshot({ mesh }));
  await userEvent.click(await screen.findByRole('button', { name: 'Écrire au mesh (à blanc)' }));
  expect(screen.getByLabelText('Pair')).toHaveProperty('value', '');
  expect(screen.getByLabelText('Texte')).toHaveProperty('value', '');
  await userEvent.selectOptions(screen.getByLabelText('Destination'), 'canal.poster');
  expect(screen.getByLabelText('Canal')).toHaveProperty('value', '');
  expect(screen.queryByRole('button', { name: 'Envoyer' })).toBeNull();
});

test.each([null, 'fil-inexploitable', '12345678-1234-1234-1234-123456789abc'])(
  'réponse DM : pair, answer et fil %s',
  async (threadId) => {
    const h = setup(
      <Boite />,
      snapshot({
        mesh: {
          ...mesh,
          inbox: [
            {
              id: 1,
              from: 'pair-test',
              to: 'cell-test',
              kind: 'question',
              content: 'Question',
              threadId,
              replyTo: null,
              obligationId: null,
              createdAt: new Date().toISOString(),
              seenAt: null,
              decidedAt: null,
            },
          ],
        },
      }),
      '/',
      {
        'POST /api/swarph/ecrire/apercu': json(200, {
          ok: false,
          kind: 'schema',
          message: 'texte vide',
        }),
      },
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Répondre (à blanc)' }));
    expect(screen.getByLabelText('Pair')).toHaveProperty('value', 'pair-test');
    expect(screen.getByLabelText('Kind')).toHaveProperty('value', 'answer');
    await voir();
    await waitFor(() =>
      expect(h.calls.find((c) => c.method === 'POST')?.body).toEqual({
        action: 'dm.envoyer',
        params: {
          pair: 'pair-test',
          kind: 'answer',
          texte: '',
          fil: threadId?.startsWith('1234') ? threadId : null,
        },
      }),
    );
  },
);

test.each(['Carte', 'Destinataire facultatif', 'Canal'])(
  'modifier %s efface aussi l’aperçu',
  async (champ) => {
    ouvrir(champ === 'Canal' ? 'canal.poster' : 'carte.note');
    await voir();
    await screen.findByText('Résumé de l’écriture');
    fireEvent.change(screen.getByLabelText(champ), {
      target: { value: champ === 'Carte' ? '102' : 'autre' },
    });
    expect(screen.queryByText('Résumé de l’écriture')).toBeNull();
  },
);
