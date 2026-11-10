// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import {
  argvEcriture,
  type ActionEcriture,
  type ParametresEcriture,
} from '../../src/shared/ecritures.js';
import {
  libelleEnvoi,
  type CodeEnvoi,
  type ResultatEnvoi,
  type ApercuEcriture,
} from '../../web/src/data/ecritures.js';
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
    ecritures: false,
    proxyConfigure: false,
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
function ouvrir(
  action: ActionEcriture = 'dm.envoyer',
  reponse?: ApercuEcriture,
  etat = snapshot(),
) {
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
  const relire = vi.fn();
  const h = setup(
    <EcrireAuMesh
      action={action}
      valeurs={{ texte, carte: 101, pair: 'pair-test', canal: 'canal-test' }}
      onClose={fermer}
      onRelire={relire}
    />,
    etat,
    '/',
    {
      'POST /api/swarph/ecrire/apercu': json(200, resultat),
    },
  );
  return { ...h, resultat, fermer, relire };
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
    expect(screen.getByRole('button', { name: 'Envoyer' })).toHaveProperty('disabled', false);
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

test('ressaisir le texte garde son nom accessible et renouvelle l’aperçu', async () => {
  const h = ouvrir();
  h.respond.set('POST /api/swarph/ecrire/apercu', (body) => {
    const { params } = body as { params: { texte: string } };
    return json(200, { ...h.resultat, texte: params.texte })();
  });
  const utilisateur = userEvent.setup();
  const zone = () => screen.getByRole('textbox', { name: /^Texte$/ });
  await utilisateur.clear(zone());
  await utilisateur.type(zone(), 'Premier texte.');
  expect(zone()).toHaveProperty('value', 'Premier texte.');
  await voir();
  await screen.findByRole('region', { name: 'Aperçu' });
  expect(document.querySelector('section[aria-label="Aperçu"] pre:last-of-type')?.textContent).toBe(
    'Premier texte.',
  );
  await utilisateur.clear(zone());
  await utilisateur.type(zone(), 'Nouveau texte.');
  expect(zone()).toHaveProperty('value', 'Nouveau texte.');
  expect(screen.queryByRole('region', { name: 'Aperçu' })).toBeNull();
  await voir();
  await screen.findByRole('region', { name: 'Aperçu' });
  expect(document.querySelector('section[aria-label="Aperçu"] pre:last-of-type')?.textContent).toBe(
    'Nouveau texte.',
  );
});

test.each([
  ['succes', 'Parti.'],
  ['proxy_unavailable', "Le proxy de ta cellule ne répond pas. Rien n'est parti."],
  ['connexion', "Le proxy de ta cellule ne répond pas. Rien n'est parti."],
  ['upstream_unreachable', "Le gateway est injoignable. Rien n'est parti."],
  ...(['upstream_ambiguous', 'delai', 'interrompu', 'format'] as const).map((code) => [
    code,
    'Envoi incertain : il est peut-être parti. Relis le fil avant de réessayer.',
  ]),
  ['upstream_error', 'Le gateway a refusé (statut 503).'],
  ...(['verb_not_allowed', 'bad_args', 'peer_not_allowed'] as const).map((code) => [
    code,
    `Le proxy a refusé cette écriture (${code}). C'est un défaut d'A-I-D ou de configuration.`,
  ]),
])('libellé %s exact et sans texte', (code, libelle) => {
  expect(
    libelleEnvoi({
      code: code as CodeEnvoi,
      status: 503,
      open_obligations: [],
      texte,
    } as ResultatEnvoi),
  ).toBe(libelle);
  expect(libelle).not.toContain(texte);
});

test('proxy absent : bouton désactivé, bandeau et copie conservés', async () => {
  const h = ouvrir();
  h.respond.set('POST /api/swarph/ecrire/envoyer', json(409, { error: 'proxy_absent' }));
  await voir();
  await userEvent.click(await screen.findByRole('button', { name: 'Envoyer' }));
  expect(
    await screen.findByText(
      "Le proxy de ta cellule n'est pas configuré. Rien ne peut partir ; l'aperçu reste disponible.",
    ),
  ).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Envoyer' })).toHaveProperty('disabled', true);
  expect(screen.getByText(/À blanc :/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Copier le texte' })).toHaveProperty('disabled', false);
  fireEvent.change(screen.getByLabelText('Texte'), { target: { value: 'Autre texte' } });
  await voir();
  expect(screen.getByRole('button', { name: 'Envoyer' })).toHaveProperty('disabled', true);
});

test('un seul envoi direct par aperçu, un champ modifié rouvre l’envoi', async () => {
  const h = ouvrir();
  h.respond.set(
    'POST /api/swarph/ecrire/envoyer',
    json(200, { code: 'succes', id: 12, open_obligations: [] }),
  );
  await voir();
  const bouton = await screen.findByRole('button', { name: 'Envoyer' });
  fireEvent.click(bouton);
  fireEvent.click(bouton);
  expect(await screen.findByText('Parti.')).toBeTruthy();
  expect(h.calls.filter((c) => c.url.endsWith('/envoyer'))).toHaveLength(1);
  expect(bouton).toHaveProperty('disabled', true);
  expect(screen.getByRole('button', { name: "Voir l'aperçu" })).toHaveProperty('disabled', true);
  fireEvent.change(screen.getByLabelText('Texte'), { target: { value: 'Autre texte' } });
  await voir();
  expect(screen.getByRole('button', { name: 'Envoyer' })).toHaveProperty('disabled', false);
});

test('attente du téléphone puis résultat de cette demande', async () => {
  const h = ouvrir();
  const demande = {
    id: 'demande-test',
    classe: 'defaut',
    resume: 'DM',
    echeance: 1,
    etat: 'ouverte',
    resultat: null,
  };
  h.respond.set('POST /api/swarph/ecrire/envoyer', json(202, { confirmation: demande.id }));
  h.respond.set('GET /api/confirmations', json(200, { ouvertes: [demande], recentes: [] }));
  await voir();
  await userEvent.click(await screen.findByRole('button', { name: 'Envoyer' }));
  expect(await screen.findByText('En attente de ta confirmation sur le téléphone.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Envoyer' })).toHaveProperty('disabled', true);
  h.respond.set(
    'GET /api/confirmations',
    json(200, {
      ouvertes: [],
      recentes: [
        {
          ...demande,
          etat: 'consommee',
          resultat: 'executee',
          envoi: { code: 'succes', id: 12, open_obligations: [] },
        },
      ],
    }),
  );
  expect(await screen.findByText('Parti.', {}, { timeout: 4500 })).toBeTruthy();
  expect(screen.queryByText('En attente de ta confirmation sur le téléphone.')).toBeNull();
});

test.each(['dm.envoyer', 'canal.poster', 'carte.note'] as const)(
  'incertain %s sans réessai',
  async (action) => {
    const h = ouvrir(action);
    h.respond.set(
      'POST /api/swarph/ecrire/envoyer',
      json(200, { code: 'interrompu', open_obligations: [] }),
    );
    await voir();
    await userEvent.click(await screen.findByRole('button', { name: 'Envoyer' }));
    const statut = await screen.findByRole('status');
    expect(statut.textContent).toBe(
      'Envoi incertain : il est peut-être parti. Relis le fil avant de réessayer.',
    );
    expect(statut.textContent).not.toContain(texte);
    expect(screen.queryByRole('button', { name: 'Réessayer' })).toBeNull();
    if (action === 'carte.note') {
      await userEvent.click(screen.getByRole('button', { name: 'Relire le fil' }));
      expect(h.relire).toHaveBeenCalledOnce();
      expect(h.fermer).toHaveBeenCalledOnce();
    } else
      expect(screen.getByText('Vérifie la Boîte ou le canal avant de réessayer.')).toBeTruthy();
  },
);

test.each([
  [
    409,
    {
      error: 'confirmation_impossible',
      message: 'Allume le PDA et active un téléphone pour cette action',
    },
  ],
  [400, { error: 'schema', message: 'Paramètres invalides' }],
  [422, { error: 'nettoyage', message: 'Adresse privée détectée' }],
])('refus %s lisible sans texte', async (status, corps) => {
  const h = ouvrir();
  h.respond.set('POST /api/swarph/ecrire/envoyer', json(status, corps));
  await voir();
  await userEvent.click(await screen.findByRole('button', { name: 'Envoyer' }));
  const alerte = await screen.findByRole('alert');
  expect(alerte.textContent).toBe(corps.message);
  expect(alerte.textContent).not.toContain(texte);
});

test.each([
  ['consommee', 'annulee', 'Annulée'],
  ['expiree', null, 'Expirée'],
] as const)('demande %s/%s sans envoi : même aperçu envoyable', async (etat, resultat, libelle) => {
  const h = ouvrir();
  h.respond.set('POST /api/swarph/ecrire/envoyer', json(202, { confirmation: 'sans-envoi' }));
  h.respond.set(
    'GET /api/confirmations',
    json(200, {
      ouvertes: [],
      recentes: [{ id: 'sans-envoi', classe: 'defaut', resume: 'DM', echeance: 1, etat, resultat }],
    }),
  );
  await voir();
  await userEvent.click(await screen.findByRole('button', { name: 'Envoyer' }));
  expect(await screen.findByText(libelle)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Envoyer' })).toHaveProperty('disabled', false);
  expect(screen.getByRole('region', { name: 'Aperçu' })).toBeTruthy();
  h.respond.set(
    'POST /api/swarph/ecrire/envoyer',
    json(200, { code: 'succes', open_obligations: [] }),
  );
  await userEvent.click(screen.getByRole('button', { name: 'Envoyer' }));
  expect(await screen.findByText('Parti.')).toBeTruthy();
  expect(h.calls.filter((c) => c.url.endsWith('/envoyer'))).toHaveLength(2);
});

test('annuler sur le cockpit rend le même aperçu envoyable', async () => {
  const h = ouvrir();
  h.respond.set('POST /api/swarph/ecrire/envoyer', json(202, { confirmation: 'annulation' }));
  h.respond.set('GET /api/confirmations', json(200, { ouvertes: [], recentes: [] }));
  h.respond.set('DELETE /api/confirmations/annulation', json(204, {}));
  await voir();
  await userEvent.click(await screen.findByRole('button', { name: 'Envoyer' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Annuler' }));
  expect(await screen.findByText('Annulée')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Envoyer' })).toHaveProperty('disabled', false);
});

test('un envoi incertain est une demande exécutée et reste verrouillé', async () => {
  const h = ouvrir();
  h.respond.set('POST /api/swarph/ecrire/envoyer', json(202, { confirmation: 'incertain' }));
  h.respond.set(
    'GET /api/confirmations',
    json(200, {
      ouvertes: [],
      recentes: [
        {
          id: 'incertain',
          classe: 'defaut',
          resume: 'DM',
          echeance: 1,
          etat: 'consommee',
          resultat: 'executee',
          envoi: { code: 'interrompu', open_obligations: [] },
        },
      ],
    }),
  );
  await voir();
  await userEvent.click(await screen.findByRole('button', { name: 'Envoyer' }));
  expect(
    await screen.findByText(libelleEnvoi({ code: 'interrompu', open_obligations: [] })),
  ).toBeTruthy();
  expect(screen.getByText('Exécutée')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Envoyer' })).toHaveProperty('disabled', true);
  expect(screen.queryByRole('button', { name: 'Réessayer' })).toBeNull();
});

test('D283 : lecture seule désactive Envoyer et conserve aperçu et copie', async () => {
  const h = ouvrir(
    'dm.envoyer',
    undefined,
    snapshot({
      mesh: { ...mesh, state: { ...mesh.state, proxyConfigure: true, ecritures: false } },
    }),
  );
  await voir();
  expect(
    await screen.findByText('Le proxy de ta cellule est en lecture seule : rien ne peut partir.'),
  ).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Envoyer' })).toHaveProperty('disabled', true);
  expect(screen.getByRole('button', { name: 'Copier le texte' })).toHaveProperty('disabled', false);
  expect(h.calls.some((c) => c.url === '/api/swarph/ecrire/envoyer')).toBe(false);
});

test('D283 : un 409 reçu malgré tout garde le message de lecture seule', async () => {
  const h = ouvrir(
    'dm.envoyer',
    undefined,
    snapshot({
      mesh: { ...mesh, state: { ...mesh.state, proxyConfigure: true, ecritures: true } },
    }),
  );
  h.respond.set('POST /api/swarph/ecrire/envoyer', json(409, { error: 'proxy_lecture_seule' }));
  await voir();
  await userEvent.click(screen.getByRole('button', { name: 'Envoyer' }));
  expect(
    await screen.findByText('Le proxy de ta cellule est en lecture seule : rien ne peut partir.'),
  ).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Envoyer' })).toHaveProperty('disabled', true);
});
