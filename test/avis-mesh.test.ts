import { describe, expect, it } from 'vitest';
import {
  decouperSousQuestions,
  lireAvis,
  type BulletinAvis,
  type PhaseAvis,
} from '../src/shared/avis-mesh.js';

const sousQuestions = [
  { n: 1, texte: 'Un ?' },
  { n: 2, texte: 'Deux ?' },
];
const corps = (verdict = 'oui') =>
  JSON.stringify({ reponses: [{ n: 1, verdict, justification: 'raison' }] });
const bulletin = (options: Partial<BulletinAvis> = {}): BulletinAvis => ({
  cell: 'a',
  tour: 'positions',
  outcome: 'pass',
  corps: corps(),
  annule: false,
  ...options,
});
const lire = (bulletins: BulletinAvis[], phase: PhaseAvis = 'clos', sieges = ['a']) =>
  lireAvis({ sousQuestions, sieges, bulletins, phase });

describe('découpage porté du 39', () => {
  it('garde le texte entier sans numéro', () =>
    expect(decouperSousQuestions(' Un ?\n Deux ? ')).toEqual([{ n: 1, texte: 'Un ?\n Deux ?' }]));
  it('garde préambule, lignes suivantes et numéros', () =>
    expect(decouperSousQuestions('Intro\n2. Un\nsuite\n4) Deux')).toEqual([
      { n: 2, texte: 'Intro\nUn\nsuite' },
      { n: 4, texte: 'Deux' },
    ]));
  it('borne à douze et refuse les numéros ambigus', () => {
    expect(
      decouperSousQuestions(Array.from({ length: 12 }, (_, i) => `${i + 1}. ?`).join('\n')),
    ).toHaveLength(12);
    for (const texte of [
      '0. ?',
      '1. ?\n1) ?',
      Array.from({ length: 13 }, (_, i) => `${i + 1}. ?`).join('\n'),
    ])
      expect(() => decouperSousQuestions(texte)).toThrow();
  });
});

describe('lecture des bulletins mesh', () => {
  it('lit le premier objet et les chaînes échappées, borne la justification', () => {
    const texte = JSON.stringify({
      reponses: [{ n: 1, verdict: 'oui', justification: '"}\\'.repeat(300) }],
    });
    const resultat = lire([bulletin({ corps: `Préambule ${texte} puis {}` })]);
    expect(resultat.format).toBe('aid-avis-mesh/1');
    expect(resultat.avis[0]!.etat).toBe('ok');
    expect(resultat.avis[0]!.reponses[0]!.justification).toHaveLength(600);
    expect(resultat.avis[0]!.reponses[1]!.verdict).toBe('manquant');
  });
  it.each([
    'pas du JSON',
    '{cassé} {}',
    '{}',
    '{"reponses":null}',
    '{"reponses":[null]}',
    '{"reponses":[{}]}',
    corps('peut_etre'),
    JSON.stringify({ reponses: [{ n: 3, verdict: 'oui', justification: '' }] }),
    JSON.stringify({
      reponses: [
        { n: 1, verdict: 'oui', justification: '' },
        { n: 1, verdict: 'non', justification: '' },
      ],
    }),
    '{"reponses":[{"n":1,"verdict":"oui"}]}',
  ])('invalide tout le bulletin : %s', (texte) => {
    const resultat = lire([bulletin({ corps: texte })]);
    expect(resultat.avis[0]!).toMatchObject({ etat: 'invalide', brut: texte, reponses: [] });
    expect(resultat.accord[0]).toMatchObject({ accord: 'insuffisant', compte: {} });
  });
  it('borne le brut invalide à 4000 caractères', () =>
    expect(lire([bulletin({ corps: 'x'.repeat(5000) })]).avis[0]!.brut).toHaveLength(4000));
  it.each([
    ['raison', 'abstention'],
    ['secret suspecté', 'secret_suspecte'],
  ] as const)('rend cannot_evaluate : %s', (texte, etat) => {
    expect(lire([bulletin({ outcome: 'cannot_evaluate', corps: texte })]).avis[0]!.etat).toBe(etat);
  });
  it('rend scellé sans interpréter le corps absent', () => {
    expect(lire([bulletin({ corps: null, outcome: null })]).avis[0]!.etat).toBe('scelle');
    expect(lire([], 'positions').avis[0]!.etat).toBe('attendu');
  });
  it('ne déclare absent qu’après positions sans dépôt non annulé', () => {
    expect(lire([]).avis[0]!.etat).toBe('absent');
    expect(lire([bulletin({ annule: true })]).avis[0]!.etat).toBe('absent');
    expect(lire([bulletin({ tour: 'rebuttal', corps: 'débat' })]).avis[0]!.etat).toBe('absent');
  });
  it('garde la position visible quand le vote est scellé', () => {
    const resultat = lire(
      [bulletin(), bulletin({ tour: 'vote', corps: null, outcome: null })],
      'vote',
    );
    expect(resultat.avis[0]).toMatchObject({
      etat: 'ok',
      vote_pris_en_compte: false,
      vote_scelle: true,
      reponses: [
        { n: 1, verdict: 'oui' },
        { n: 2, verdict: 'manquant' },
      ],
    });
    expect(resultat.accord[0]!.compte).toEqual({ oui: 1 });
  });
  it('distingue un vote scellé sans position d’un siège absent', () => {
    expect(lire([bulletin({ tour: 'vote', corps: null })], 'vote').avis[0]).toMatchObject({
      etat: 'scelle',
      vote_pris_en_compte: false,
      vote_scelle: true,
    });
  });
  it.each(['positions', 'rebuttal', 'vote', 'clos'] as const)(
    'ne prend pas un rebuttal pour une position en phase %s',
    (phase) => {
      expect(lire([bulletin({ tour: 'rebuttal' })], phase).avis[0]!.etat).toBe(
        phase === 'positions' ? 'attendu' : 'absent',
      );
    },
  );
  it('remplace les positions par le vote et ignore les annulés', () => {
    const bulletins = [
      bulletin(),
      bulletin({ tour: 'vote', corps: corps('non') }),
      bulletin({ tour: 'vote', annule: true }),
    ];
    expect(lire(bulletins).avis[0]!).toMatchObject({
      vote_pris_en_compte: true,
      vote_scelle: false,
      reponses: [
        { n: 1, verdict: 'non' },
        { n: 2, verdict: 'manquant' },
      ],
    });
    expect(lire(bulletins, 'rebuttal').avis[0]!.vote_pris_en_compte).toBe(false);
    expect(
      lire([bulletin(), bulletin({ tour: 'vote', corps: 'invalide' })]).accord[0]!.compte,
    ).toEqual({});
  });
  it('sépare les rebuttals sans les compter et ignore les cells hors sièges', () => {
    const resultat = lire([
      bulletin({ tour: 'rebuttal', corps: 'texte' }),
      bulletin({ tour: 'rebuttal', annule: true }),
      bulletin({ cell: 'hors' }),
    ]);
    expect(resultat.rebuttals).toEqual([{ cell: 'a', texte: 'texte' }]);
    expect(resultat.accord[0]!.compte).toEqual({});
  });
  it.each([
    [[], 'insuffisant', null, {}],
    [['oui'], 'insuffisant', null, { oui: 1 }],
    [['oui', 'oui'], 'unanime', 'oui', { oui: 2 }],
    [['oui', 'oui', 'non'], 'majorite', 'oui', { oui: 2, non: 1 }],
    [['oui', 'non'], 'partage', null, { oui: 1, non: 1 }],
    [['nuance', 'ne_sait_pas'], 'partage', null, { nuance: 1, ne_sait_pas: 1 }],
  ] as const)('calcule l’accord pour %j', (verdicts, accord, verdict, compte) => {
    const sieges = verdicts.map((_, i) => `cell-${i}`);
    const resultat = lire(
      verdicts.map((v, i) => bulletin({ cell: sieges[i], corps: corps(v) })),
      'clos',
      sieges,
    );
    expect(resultat.accord[0]).toEqual({ n: 1, accord, verdict, compte });
  });
});
