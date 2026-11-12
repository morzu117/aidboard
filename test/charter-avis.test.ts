import { describe, expect, it } from 'vitest';
import {
  charterAvis,
  citerQuestion,
  jetonCitation,
  refuserMarqueurs,
  validerQuestionMesh,
} from '../src/shared/charter-avis.js';

describe('charter avis', () => {
  it('tire quatre octets et permet leur injection', () => {
    expect(jetonCitation()).toMatch(/^[a-f0-9]{8}$/);
    expect(
      jetonCitation((taille) => {
        expect(taille).toBe(4);
        return Uint8Array.of(0, 1, 254, 255);
      }),
    ).toBe('0001feff');
    expect(() => jetonCitation(() => new Uint8Array(3))).toThrow();
  });
  it.each(['<<<QUESTION', '<<<question-ab', 'QuEsTiOn>>>'])('refuse le marqueur %s', (texte) => {
    expect(refuserMarqueurs(texte)).toEqual({ ok: false, classe: 'marqueur de citation' });
    expect(validerQuestionMesh(texte).ok).toBe(false);
  });
  it.each(['secret=exemple-factice', 'aid-e2e.ts.net'])(
    'refuse sans recopier la donnée',
    (texte) => {
      const resultat = validerQuestionMesh(texte);
      expect(resultat.ok).toBe(false);
      expect(JSON.stringify(resultat)).not.toContain(texte);
      expect(resultat).toHaveProperty('classe');
    },
  );
  it('accepte la limite et les adresses de documentation', () => {
    expect(validerQuestionMesh('a'.repeat(8000))).toEqual({ ok: true });
    expect(validerQuestionMesh('😀'.repeat(8000))).toEqual({ ok: true });
    expect(validerQuestionMesh('a'.repeat(8001))).toEqual({ ok: false, classe: 'texte trop long' });
    expect(validerQuestionMesh('example.com 192.0.2.1')).toEqual({ ok: true });
  });
  it('cite et fixe toutes les prescriptions du charter', () => {
    const jeton = '0001feff';
    expect(citerQuestion('Pourquoi ?', jeton)).toBe(
      '<<<QUESTION-0001feff\nPourquoi ?\nQUESTION-0001feff>>>',
    );
    const charter = charterAvis({ jeton, carte: 40, nbSousQuestions: 2 });
    for (const texte of [
      '<<<QUESTION-0001feff',
      'QUESTION-0001feff>>>',
      'swarph committee motion <canal>',
      'swarph committee post <canal> --round positions --body-file <fichier>',
      'swarph committee post <canal> --round vote --body-file <fichier>',
      'Les options de la motion valent avis,objection',
      "Ces options ne servent pas à s'abstenir",
      "l'abstention passe uniquement par --outcome cannot_evaluate",
      'post dépose pass par défaut',
      'nulle part ailleurs que par post',
      'secret suspecté',
      '--outcome cannot_evaluate',
      'scellé par le gateway',
      'coût est consenti à l’ouverture'.replace('’', "'"),
      'n en double ou absent',
      'oui, non, nuance ou ne_sait_pas',
      'carte 40',
      '2 sous-questions',
    ])
      expect(charter).toContain(texte);
    expect(charter.toLowerCase()).not.toContain('invisible');
  });
});

it('révision 3 : sens des tours rebuttal et vote, baseline sans vote', () => {
  const charter = charterAvis({ jeton: 'abcdef12', carte: 42, nbSousQuestions: 1 });
  expect(charter).toContain(
    'Au tour rebuttal, un texte libre facultatif, en réponse aux positions des autres, devenues lisibles.',
  );
  expect(charter).toContain(
    "Au tour vote, l'option avis si ta position tient, objection sinon, avec dans le corps le même JSON qu'au tour positions, mis à jour.",
  );
  expect(charter).toContain('Le baseline ne vote pas.');
  expect(charter).toContain('Les trois tours sont obligatoires');
});
