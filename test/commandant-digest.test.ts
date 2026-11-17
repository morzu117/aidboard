import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { digestCommandant, serialiserJcs } from '../src/shared/commandant.js';

describe('JCS du commandant', () => {
  it('reproduit V4 tel quel (annexe A.1)', () => {
    const valeur = {
      id: 1237,
      params: {
        needs_sso: false,
        options: ['oui', 'non'],
        question: 'Déployer "0.84.0" depuis C:\\swarph/bin ? 🚀',
      },
      type: 'decision',
    };
    expect(digestCommandant(valeur)).toBe(
      'bcb0d63a5130f6349eefb14e443576c2b6f6ccd245abdbace8490165cc10a82b',
    );
  });
  it('reproduit V5 tel quel (addendum)', () => {
    const valeur = {
      id: 1237,
      params: {
        needs_sso: false,
        options: ['a "quoted" one', 'back\\slash', 'a/b'],
        question: 'Chemin C:\\tmp et « guillemets » 😀 ?',
      },
      type: 'decision',
    };
    expect(digestCommandant(valeur)).toBe(
      '707bea717c787a3875ccfaeaf4dff634b288a862b85078f2d067c441fa3bd758',
    );
  });
  it('trie les clés UTF-16, y compris numériques, dans les tableaux imbriqués', () => {
    expect(
      serialiserJcs({ z: [{ z: -7, a: [{ b: true, a: null }] }], '2': 2, '10': 10, a: '' }),
    ).toBe('{"10":10,"2":2,"a":"","z":[{"a":[{"a":null,"b":true}],"z":-7}]}');
    expect(serialiserJcs({ '\ue000': 1, '😀': 2 })).toBe('{"😀":2,"":1}');
  });
  it('garde la chaîne vide, les contrôles échappés, le solidus et les entiers négatifs', () => {
    const valeur = {
      id: 7,
      type: 'decision',
      params: { z: '\u0001', vide: '', chemin: 'a/b\\c"', negatif: -17 },
    };
    const jcs =
      '{"id":7,"params":{"chemin":"a/b\\\\c\\"","negatif":-17,"vide":"","z":"\\u0001"},"type":"decision"}';
    expect(serialiserJcs(valeur)).toBe(jcs);
    expect(digestCommandant(valeur)).toBe(createHash('sha256').update(jcs).digest('hex'));
  });
  it('ne normalise pas Unicode et accepte les bornes sûres', () => {
    expect(serialiserJcs([Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, -0])).toBe(
      '[-9007199254740991,9007199254740991,0]',
    );
    expect(digestCommandant({ id: 1, type: 'decision', params: { texte: 'é' } })).not.toBe(
      digestCommandant({ id: 1, type: 'decision', params: { texte: 'e\u0301' } }),
    );
  });
  it.each([
    0.5,
    Number.MAX_SAFE_INTEGER + 1,
    Number.MIN_SAFE_INTEGER - 1,
    NaN,
    Infinity,
    undefined,
    () => 1,
    1n,
    Symbol('test'),
    new Date(),
    { x: undefined },
    [undefined],
    Array(1),
    '\ud800',
    { '\udfff': 1 },
  ])('refuse la valeur hors contrat %#', (valeur) => {
    expect(() => serialiserJcs(valeur)).toThrow();
  });
  it('refuse un cycle mais accepte une référence partagée', () => {
    const v: unknown[] = [];
    v.push(v);
    expect(() => serialiserJcs(v)).toThrow();
    const objet = { a: 1 };
    expect(serialiserJcs([objet, objet])).toBe('[{"a":1},{"a":1}]');
  });
});
