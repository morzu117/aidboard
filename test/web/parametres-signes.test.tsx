// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { ParametresSignes } from '../../web/src/ui/ParametresSignes.js';
import { RAISON_BASELINE_ABSENT } from '../../src/shared/avis-mesh-api.js';

const hostile = '<img src=x onerror="alert(1)"> **texte**';
const tete = 'a'.repeat(40);
const echeances = { positions: '2026-11-12', rebuttal: '2026-11-13', vote: '2026-11-14' };
const cas: [string, unknown, string][] = [
  [
    'merge',
    {
      topicId: 'sujet',
      depot: 'exemple/depot',
      pr: 42,
      tete,
      strategie: 'squash',
      supprimerBranche: true,
      nettoyer: false,
      teteNettoyage: null,
    },
    'Dépôt : exemple/depot',
  ],
  [
    'push',
    { topicId: 'sujet', branche: 'sujet/test', tete, distante: null },
    'Distante : nouvelle branche',
  ],
  [
    'nettoyage',
    {
      topicId: 'sujet',
      branche: 'sujet/test',
      tete: null,
      etat: 'sale',
      nonFusionnes: 2,
      sale: 'stash',
    },
    'Commits non fusionnés perdus : 2',
  ],
  [
    'projet.retirer',
    { workspaceId: 'projet', racine: '/exemple/projet' },
    'Racine : /exemple/projet',
  ],
  [
    'appairage',
    { appairageId: 'appareil', nom: 'Téléphone', hIdentite: null, sansIdentite: true },
    'Sans identité Tailscale',
  ],
  [
    'pda.activer',
    { appareilId: 'appareil', nom: 'Téléphone', empreinte: 'ABCD-EFGH' },
    'Empreinte : ABCD-EFGH',
  ],
  ['host.option', { option: 'code', actif: true }, 'Actif : oui'],
  ['reglage', { action: 'merge', actif: false }, 'Actif : non'],
  ['essai', {}, 'aucun paramètre'],
  ['desarmement', {}, 'Les actions ne demanderont plus de confirmation'],
  [
    'mesh.avis',
    {
      params: {
        id: 'avis',
        nom: hostile,
        carte: 42,
        texte: hostile,
        sieges: [{ peer: 'exemple', role: 'chair', family: 'exemple' }],
        echeances,
      },
    },
    `Salle : ${hostile}`,
  ],
  [
    'mesh.avis.motion',
    { params: { id: 'avis', canal: 'exemple', texte: hostile, echeances } },
    hostile,
  ],
  [
    'mesh.avis.baseline-absent',
    { params: { id: 'avis', canal: 'exemple', motion: 1, raison: RAISON_BASELINE_ABSENT } },
    'Motion : 1',
  ],
  ...['carte.note', 'dm.envoyer', 'canal.poster'].map((action): [string, unknown, string] => [
    'mesh.ecrire',
    {
      action,
      params: {
        kind: 'fyi',
        texte: hostile,
        ...(action === 'carte.note'
          ? { carte: 42, a: null }
          : action === 'dm.envoyer'
            ? { pair: 'exemple', fil: null }
            : { canal: 'exemple' }),
      },
    },
    `texte : ${hostile}`,
  ]),
  [
    'mesh.etat',
    {
      action: 'carte.deplacer',
      params: { carte: 42, etape: 'review', attendu: { stage: 'build', stageVersion: 1 } },
    },
    'etape : review',
  ],
  [
    'mesh.etat',
    {
      action: 'obligation.prendre',
      params: { carte: 42, obligation: 1, attendu: { status: 'open' } },
    },
    'obligation : 1',
  ],
  [
    'mesh.etat',
    {
      action: 'obligation.refuser',
      params: { carte: 42, obligation: 1, attendu: { status: 'open' }, motif: hostile },
    },
    `motif : ${hostile}`,
  ],
  [
    'mesh.etat',
    {
      action: 'obligation.clore',
      params: {
        carte: 42,
        obligation: 1,
        attendu: { status: 'open', acceptSha256: 'a'.repeat(64) },
        issue: 'pass',
        preuve: hostile,
      },
    },
    `preuve : ${hostile}`,
  ],
];
afterEach(cleanup);

test.each(cas)('%s : affiche les paramètres comme du texte (%#)', (action, params, attendu) => {
  const { container } = render(<ParametresSignes action={action} params={params} surface="mac" />);
  expect(screen.getByText(attendu)).toBeTruthy();
  expect(container.querySelector('img, script, strong')).toBeNull();
});

test.each(cas)('%s : protège les accès aux formes inattendues (%#)', (action) => {
  for (const params of [
    undefined,
    [],
    'texte',
    42,
    { params: null },
    { params: { sieges: [null] } },
  ]) {
    const vue = render(<ParametresSignes action={action} params={params} surface="mac" />);
    expect(screen.getByText('illisible')).toBeTruthy();
    vue.unmount();
  }
});

test('NULL : aucun paramètre, même pour une ancienne demande essai', () => {
  render(<ParametresSignes action="essai" params={null} surface="mac" />);
  expect(screen.getByText('aucun paramètre')).toBeTruthy();
});

test('retrait : chemin entier sur Mac, dernier segment sur téléphone', () => {
  const params = { workspaceId: 'projet', racine: '/exemple/parent/projet/' };
  const vue = render(<ParametresSignes action="projet.retirer" params={params} surface="mac" />);
  expect(screen.getByText('Racine : /exemple/parent/projet/')).toBeTruthy();
  vue.rerender(<ParametresSignes action="projet.retirer" params={params} surface="telephone" />);
  expect(screen.getByText('Racine : projet')).toBeTruthy();
  expect(vue.container.textContent).not.toContain('/exemple');
});

test.each(['mac', 'telephone'] as const)(
  'les paramètres signés restent sans avatar sur %s',
  (surface) => {
    const { container } = render(
      <ParametresSignes
        action="mesh.ecrire"
        params={{
          action: 'dm.envoyer',
          params: { pair: 'peer-a', texte: 'Exemple', kind: 'fyi', fil: null },
        }}
        surface={surface}
      />,
    );
    expect(container.querySelector('.avatar-cell')).toBeNull();
    expect(container.textContent).toContain('peer-a');
  },
);
