import { expect, test } from 'vitest';
import {
  argsProxy,
  argvEcriture,
  lireParamsEcriture,
  resumeEcriture,
  lignesCreation,
  creationIncertaine,
  messageCreation,
} from '../../src/shared/ecritures.js';
import {
  CLASSE_ACTION,
  resumeAction,
  validerParamsAction,
} from '../../src/shared/confirmations.js';
import { jsonCanonique, lireCorpsDemande, resumeActionMesh } from '../../src/shared/pda.js';

const params = {
  projet: 17,
  projetNom: 'Projet exemple',
  titre: 'Une carte',
  corps: 'Swairm: exemple/depot#sujet-1',
};
const lire = (p: unknown) => lireParamsEcriture('carte.creer', p, 'peer-a');

test('D338 : classe toujours, résumé court et informations tirées des paramètres signés', () => {
  expect(CLASSE_ACTION['mesh.ecrire']).toBe('toujours');
  expect(validerParamsAction('mesh.ecrire', { action: 'carte.creer', params })).toBe(true);
  expect(resumeAction('mesh.ecrire', { action: 'carte.creer', params })).toBe(
    'Création de carte dans le projet #17',
  );
  expect(lignesCreation(params)).toEqual([
    'Titre : Une carte',
    'Projet : Projet exemple (#17)',
    'Sujet : exemple/depot#sujet-1',
  ]);
  expect(
    resumeEcriture('carte.creer', {
      ...params,
      titre: '😀'.repeat(200),
      projetNom: 'é'.repeat(100),
    }).length,
  ).toBeLessThanOrEqual(160);
  expect(argvEcriture('carte.creer', params, 'peer-a')).toEqual([]);
});

test.each([0, -1, 1.5, true, '17', 'projet', null, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
  'id de projet entier positif : %s refusé',
  (projet) => {
    expect(lire({ ...params, projet }).ok).toBe(false);
  },
);
test.each(['', ' ', '\t', 'a'.repeat(201), 'a\nb', 'a\rb', 'a\u2028b', 'a\0b', 42])(
  'titre refusé : %j',
  (titre) => {
    expect(lire({ ...params, titre }).ok).toBe(false);
  },
);
test('titre compté en caractères après strip, bornes 1 et 200 incluses', () => {
  for (const titre of [' a ', '  ' + '😀'.repeat(200) + '  '])
    expect(lire({ ...params, titre })).toEqual({
      ok: true,
      params: { ...params, titre: titre.trim() },
    });
});
test.each(['', ' ', 'x'.repeat(101), 'a\nb', 'a\0b', 17, null])(
  'nom de projet borné : %j refusé',
  (projetNom) => {
    expect(lire({ ...params, projetNom }).ok).toBe(false);
  },
);
test.each([
  '',
  'texte\nSwairm: exemple/depot#1',
  ' Swairm: exemple/depot#1',
  'Swairm: exemple/depot#1 ',
  'Swairm: exemple/depot#1\r\n',
  'Swairm: depot#1',
  'Swairm: exemple/depot#',
  'Swairm: exemple/depot#1\0',
  1,
])('première ligne exacte : %j refusée', (corps) => {
  expect(lire({ ...params, corps }).ok).toBe(false);
});
test('corps entier borné à 4 000 caractères Unicode', () => {
  const corps = params.corps + '\n\n' + '😀'.repeat(4000 - Array.from(params.corps).length - 2);
  expect(lire({ ...params, corps }).ok).toBe(true);
  expect(lire({ ...params, corps: corps + 'a' }).ok).toBe(false);
});
test('schéma fermé, chaque paramètre requis et aucun champ transmis hors schéma', () => {
  for (const cle of Object.keys(params))
    expect(lire(Object.fromEntries(Object.entries(params).filter(([k]) => k !== cle))).ok).toBe(
      false,
    );
  for (const cle of ['priority', 'labels', 'assignee', 'actor', 'from_node', 'stage', 'mesh'])
    expect(lire({ ...params, [cle]: 'interdit' }).ok).toBe(false);
  expect(argsProxy('carte.creer', params)).toEqual({
    verb: 'board.cards.create',
    args: { project: 17, title: 'Une carte', body: params.corps },
  });
});
test('le contrat signé v3 conserve 160 caractères et les paramètres complets', () => {
  const p = { ...params, titre: 'a'.repeat(200), projetNom: 'p'.repeat(100) };
  const ecriture = { action: 'carte.creer' as const, params: p };
  const mesh = { nom: 'principal', cell: 'peer-a', gateway: 'A'.repeat(43), proxy: 'A'.repeat(43) };
  const corps = {
    v: 3,
    id: 'A'.repeat(22),
    action: 'mesh.ecrire',
    classe: 'toujours',
    params: ecriture,
    resume: resumeActionMesh(mesh, 'mesh.ecrire', ecriture),
    numero: null,
    echeance: 2000,
    emise: 1000,
    mesh,
  };
  expect(lireCorpsDemande(Buffer.from(jsonCanonique(corps)))).toEqual(corps);
});
test.each([
  'bad_args',
  'verb_not_allowed',
  'peer_not_allowed',
  'proxy_unavailable',
  'connexion',
  'upstream_unreachable',
  'upstream_error',
  'succes',
] as const)('D339 : issue certaine %s', (code) => {
  expect(creationIncertaine(code)).toBe(false);
});
test.each(['upstream_ambiguous', 'interrompu', 'delai', 'format'] as const)(
  'D339/D263 : issue incertaine %s',
  (code) => {
    expect(creationIncertaine(code)).toBe(true);
  },
);
test('messages D339 sans detail amont', () => {
  expect(messageCreation('verb_not_allowed')).toBe(
    "Le proxy a refusé de créer la carte : il est trop ancien (swarph-cli 0.82.0 requis) ou en lecture seule. Rien n'a été créé.",
  );
  expect(messageCreation('upstream_error', 403)).toBe(
    "Le board a refusé cette création (403) : ta cell n'a pas le droit d'écrire dans ce projet.",
  );
});
