import { describe, expect, it } from 'vitest';
import {
  controlerLigneCommandant,
  dateCommandant,
  digestCommandant,
  STATUTS_COMMANDANT,
  type LigneCommandant,
} from '../src/shared/commandant.js';
import { ligneCommandantTest } from './fixtures/passerelle-commandant.js';

const controle = (changer: (v: LigneCommandant) => void, recalculer = false) => {
  const v = ligneCommandantTest();
  changer(v);
  if (recalculer) v.digest = digestCommandant(v);
  return controlerLigneCommandant(v);
};
describe('contrôle pur des lignes A1/A.1/A.2', () => {
  it('accepte une question et calcule ses instants RFC3339', () => {
    expect(controlerLigneCommandant(ligneCommandantTest())).toMatchObject({
      valide: true,
      repondable: true,
      dates: {
        creation: Date.parse('2026-11-17T07:14:44.520968+00:00'),
        decision: null,
        execution: null,
      },
    });
  });
  it('refuse le digest faux sans rendre summary ni why', () => {
    expect(
      controle((v) => {
        v.digest = '0'.repeat(64);
        v.why = 'contenu prive';
      }),
    ).toEqual({ valide: false, id: 1235, raison: 'digest' });
  });
  it('refuse un digest majuscule', () =>
    expect(
      controle((v) => {
        v.digest = v.digest.toUpperCase();
      }),
    ).toMatchObject({ raison: 'digest' }));
  it('refuse des params non JSON', () =>
    expect(
      controlerLigneCommandant({ ...ligneCommandantTest(), params: { x: 0.5 } }),
    ).toMatchObject({ raison: 'digest' }));
  it.each([[], Array(13).fill('ligne'), ['x'.repeat(121)], [1], null])(
    'refuse la forme ou les limites de summary %#',
    (summary) =>
      expect(controlerLigneCommandant({ ...ligneCommandantTest(), summary })).toMatchObject({
        raison: 'summary',
      }),
  );
  it.each([
    '\u0000',
    '\u0001',
    '\n',
    '\u007f',
    '\u0085',
    '\u009f',
    '\u061c',
    '\u202e',
    '\u2066',
    '\u200b',
    '\u200c',
    '\u200d',
    '\u2060',
    '\ufeff',
  ])('refuse le caractère interdit %# dans summary et why', (caractere) => {
    expect(
      controle((v) => {
        v.summary = ['texte' + caractere];
      }),
    ).toMatchObject({ raison: 'summary' });
    expect(
      controle((v) => {
        v.why = 'texte' + caractere;
      }),
    ).toMatchObject({ raison: 'why' });
  });
  it.each(['x'.repeat(1001), 1, undefined])('refuse why hors contrat %#', (why) =>
    expect(controlerLigneCommandant({ ...ligneCommandantTest(), why })).toMatchObject({
      raison: 'why',
    }),
  );
  it('compte les caractères hors BMP une fois et accepte les bornes', () => {
    expect(
      controle((v) => {
        v.summary = Array(12).fill('🚀'.repeat(120));
        v.why = '🚀'.repeat(1000);
      }),
    ).toMatchObject({ valide: true });
  });
  it.each(['question', 'options', 'head_sha'] as const)('refuse la copie divergente %s', (cle) =>
    expect(
      controle((v) => {
        v[cle] = 'autre';
      }),
    ).toMatchObject({ raison: cle }),
  );
  it('applique absent=null aux copies et affiche depuis params', () => {
    const v = ligneCommandantTest(1, 'required_checks');
    const c = controlerLigneCommandant(v);
    expect(c).toMatchObject({
      valide: true,
      repondable: false,
      ligne: { question: null, options: null, head_sha: null, needs_sso: true },
    });
    const q = ligneCommandantTest();
    const resultat = controlerLigneCommandant(q);
    if (!resultat.valide) throw new Error('ligne refusee');
    expect(resultat.ligne.options).toBe(q.params.options);
  });
  it('refuse une action sans needs_sso vrai, quelle que soit sa présence dans params', () => {
    const v = ligneCommandantTest(1, 'merge_pr');
    v.needs_sso = false;
    expect(controlerLigneCommandant(v)).toMatchObject({ raison: 'needs_sso' });
    expect(controlerLigneCommandant(ligneCommandantTest(2, 'autre_action'))).toMatchObject({
      valide: true,
      repondable: false,
    });
  });
  it('refuse une decision dont needs_sso diverge et accepte une ancienne sans clé', () => {
    expect(
      controle((v) => {
        v.needs_sso = true;
      }),
    ).toMatchObject({ raison: 'needs_sso' });
    expect(
      controle((v) => {
        delete v.params.needs_sso;
      }, true),
    ).toMatchObject({ valide: true, repondable: true });
    expect(
      controle((v) => {
        delete v.params.needs_sso;
        v.needs_sso = true;
      }, true),
    ).toMatchObject({ raison: 'needs_sso' });
    expect(
      controle((v) => {
        v.params.needs_sso = 'false';
      }, true),
    ).toMatchObject({ raison: 'needs_sso' });
  });
  it('une decision SSO est lisible seulement', () =>
    expect(
      controle((v) => {
        v.params.needs_sso = true;
        v.needs_sso = true;
      }, true),
    ).toMatchObject({ valide: true, repondable: false }));
  it.each(STATUTS_COMMANDANT)('accepte le statut %s et ne répond que si pending', (status) =>
    expect(
      controle((v) => {
        v.status = status;
      }),
    ).toMatchObject({ valide: true, repondable: status === 'pending' }),
  );
  it('refuse un statut inconnu', () =>
    expect(controlerLigneCommandant({ ...ligneCommandantTest(), status: 'done' })).toMatchObject({
      raison: 'statut',
    }));
  it.each(['created_at', 'decided_at', 'executed_at'] as const)(
    'refuse une date invalide %s',
    (cle) =>
      expect(
        controle((v) => {
          v[cle] = '2026-02-30T00:00:00Z';
        }),
      ).toMatchObject({ raison: 'date' }),
  );
  it.each([
    '2026-11-17',
    '2026-11-17T12:00:00',
    '2026-11-17T24:00:00Z',
    '2026-11-17T12:00:00+24:00',
  ])('refuse la date hors RFC3339 %s', (date) => expect(dateCommandant(date)).toBeNull());
  it('compare les instants avec décalages et fractions', () =>
    expect(dateCommandant('2026-11-17T08:00:00.123456+01:00')).toBe(
      dateCommandant('2026-11-17T07:00:00.123456Z'),
    ));
  it.each([
    { question: 'x'.repeat(361) },
    { options: Array(7).fill('a') },
    { options: ['x'.repeat(41)] },
    { question: 'x\n' },
    { options: ['x\u200b'] },
  ])('une ancienne question dépassant les limites reste en lecture seule %#', (params) => {
    const v = ligneCommandantTest();
    Object.assign(v.params, params);
    v.question = v.params.question!;
    v.options = v.params.options!;
    v.digest = digestCommandant(v);
    expect(controlerLigneCommandant(v)).toMatchObject({ valide: true, repondable: false });
  });
  it('accepte zéro option et les limites de question/options', () => {
    expect(
      controle((v) => {
        v.params.options = [];
        v.options = [];
      }, true),
    ).toMatchObject({ repondable: true });
    expect(
      controle((v) => {
        v.params.question = '🚀'.repeat(360);
        v.question = v.params.question;
        v.params.options = Array(6).fill('a'.repeat(40));
        v.options = v.params.options;
      }, true),
    ).toMatchObject({ repondable: true });
  });
  it.each([
    null,
    {},
    { ...ligneCommandantTest(), id: '1' },
    { ...ligneCommandantTest(), params: [] },
  ])('refuse une forme invalide %#', (v) =>
    expect(controlerLigneCommandant(v)).toMatchObject({ valide: false, raison: 'forme' }),
  );
});
it('la restriction aux entiers porte sur les données du digest, pas sur result_detail hors digest', () => {
  const v = ligneCommandantTest();
  v.result_detail = { duree: 0.5 };
  expect(controlerLigneCommandant(v)).toMatchObject({ valide: true });
});
it.each([
  ['proposer', 100, 'cell\u202e'],
  ['answer', 1000, 'texte\u200b'],
  ['result', 4000, 'texte\u0001'],
  ['decided_by', 200, 'sso:test\u007f'],
  ['executed_by', 200, 'sso:test\u0085'],
] as const)(
  'refuse les caractères interdits, la longueur et le type de %s',
  (champ, maximum, interdit) => {
    for (const valeur of [interdit, 'x'.repeat(maximum + 1), undefined, 123]) {
      expect(controlerLigneCommandant({ ...ligneCommandantTest(), [champ]: valeur })).toEqual({
        valide: false,
        id: 1235,
        raison: 'forme',
      });
    }
    expect(
      controlerLigneCommandant({ ...ligneCommandantTest(), [champ]: '🚀'.repeat(maximum) }),
    ).toMatchObject({ valide: true });
    if (champ !== 'proposer')
      expect(controlerLigneCommandant({ ...ligneCommandantTest(), [champ]: null })).toMatchObject({
        valide: true,
      });
  },
);
it.each(['', null])('proposer est obligatoire et non vide %#', (proposer) => {
  expect(controlerLigneCommandant({ ...ligneCommandantTest(), proposer })).toMatchObject({
    valide: false,
    raison: 'forme',
  });
});
