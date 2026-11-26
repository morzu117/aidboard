import { describe, expect, it } from 'vitest';
import { lireRevue } from '../../src/daemon/boucle/revue.js';

const FICHIER = 'src/exemple.ts';
const AUTRE_FICHIER = 'src/filtre.ts';
const POINT = 'critere-a';
const AUTRE_POINT = 'critere-b';
const TETE = 'a'.repeat(40);
const ATTENDU = {
  fichiers: [FICHIER, AUTRE_FICHIER],
  points: [POINT, AUTRE_POINT],
  tete: TETE,
};
const VERDICTS = {
  fichiers: { [FICHIER]: 'pass', [AUTRE_FICHIER]: 'pass' },
  points: { [POINT]: 'pass', [AUTRE_POINT]: 'pass' },
};
const FICHIER_EN_ECHEC = { ...VERDICTS.fichiers, [FICHIER]: 'fail' };
const POINT_EN_ECHEC = { ...VERDICTS.points, [POINT]: 'fail' };
const FINDING = {
  severite: 'majeure',
  categorie: 'bug',
  emplacement: `${FICHIER}:12`,
  probleme: 'Le filtre ignore un critère.',
  action: 'Appliquer le critère.',
  point: POINT,
};
const REVUE = { tete: TETE, verdicts: VERDICTS, findings: [] };

function bloc(revue: object) {
  return `\`\`\`json\n${JSON.stringify(revue)}\n\`\`\``;
}

describe('lecture de la page de revue', () => {
  it('valide une revue sans finding quand tous les verdicts sont présents', () => {
    expect(lireRevue(`## Revue\n\n${bloc(REVUE)}\n\nFin de revue.`, ATTENDU)).toEqual({
      ok: true,
      verdicts: VERDICTS,
      findings: [],
      categories: [],
    });
  });

  it('valide les deux verdicts fail justifiés et conserve une catégorie inconnue', () => {
    const verdicts = { fichiers: FICHIER_EN_ECHEC, points: POINT_EN_ECHEC };
    const findings = [FINDING, { ...FINDING, categorie: 'categorie-inconnue' }];
    expect(lireRevue(bloc({ ...REVUE, verdicts, findings }), ATTENDU)).toEqual({
      ok: true,
      verdicts,
      findings,
      categories: ['bug', 'categorie-inconnue'],
    });
  });

  it.each([
    ['CLEAN en prose sans bloc', 'CLEAN'],
    ['un JSON vide', bloc({})],
    ['un JSON mal formé', '```json\n{"tete":\n```'],
    ['deux blocs JSON valides', `${bloc(REVUE)}\n\n${bloc(REVUE)}`],
    ['une tête différente', bloc({ ...REVUE, tete: 'b'.repeat(40) })],
    [
      'un verdict de fichier manquant malgré zéro finding',
      bloc({ ...REVUE, verdicts: { ...VERDICTS, fichiers: { [FICHIER]: 'pass' } } }),
    ],
    [
      'un verdict de point manquant malgré zéro finding',
      bloc({ ...REVUE, verdicts: { ...VERDICTS, points: { [POINT]: 'pass' } } }),
    ],
    [
      'un verdict pour un fichier hors du diff',
      bloc({
        ...REVUE,
        verdicts: { ...VERDICTS, fichiers: { ...VERDICTS.fichiers, 'src/hors-diff.ts': 'pass' } },
      }),
    ],
    [
      'un verdict pour un point hors du plan',
      bloc({
        ...REVUE,
        verdicts: { ...VERDICTS, points: { ...VERDICTS.points, 'hors-plan': 'pass' } },
      }),
    ],
    [
      'une valeur de verdict inconnue',
      bloc({
        ...REVUE,
        verdicts: { ...VERDICTS, fichiers: { ...VERDICTS.fichiers, [FICHIER]: 'ok' } },
      }),
    ],
    [
      'un finding sans catégorie',
      bloc({ ...REVUE, findings: [{ ...FINDING, categorie: undefined }] }),
    ],
    ['un finding sans action', bloc({ ...REVUE, findings: [{ ...FINDING, action: undefined }] })],
    [
      'un emplacement sans ligne',
      bloc({ ...REVUE, findings: [{ ...FINDING, emplacement: FICHIER }] }),
    ],
    [
      'un fail de fichier sans finding',
      bloc({ ...REVUE, verdicts: { ...VERDICTS, fichiers: FICHIER_EN_ECHEC } }),
    ],
    [
      'un fail de fichier avec un finding dans un autre fichier',
      bloc({
        ...REVUE,
        verdicts: { ...VERDICTS, fichiers: FICHIER_EN_ECHEC },
        findings: [{ ...FINDING, emplacement: `${AUTRE_FICHIER}:12` }],
      }),
    ],
    [
      'un fail de point avec un finding qui ne désigne aucun point',
      bloc({
        ...REVUE,
        verdicts: { ...VERDICTS, points: POINT_EN_ECHEC },
        findings: [{ ...FINDING, point: undefined }],
      }),
    ],
  ])('refuse %s', (_cas, texte) => {
    expect(lireRevue(texte, ATTENDU)).toEqual({
      ok: false,
      raison: expect.stringMatching(/\S/),
    });
  });
});
