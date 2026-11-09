import { describe, expect, it } from 'vitest';
import {
  argvEcriture,
  lireParamsEcriture,
  lireReponseEcriture,
  resumeEcriture,
  type ActionEcriture,
} from '../../src/shared/ecritures.js';
const texte = 'Message de démonstration';
const fil = '00000000-0000-0000-0000-000000000001';
describe('écritures à blanc', () => {
  it('fige les argv et résumés, avec et sans options', () => {
    for (const a of [null, 'peer-b']) {
      const p = { carte: 1457, kind: 'fyi' as const, texte, a };
      expect(argvEcriture('carte.note', p, 'peer-a')).toEqual([
        'board',
        'cards',
        'say',
        '1457',
        '--content-file',
        'FICHIER',
        '--kind',
        'fyi',
        ...(a ? ['--to', a] : []),
        '--as',
        'peer-a',
      ]);
      expect(resumeEcriture('carte.note', p)).toBe(
        `Note fyi sur la carte #1457${a ? ', à peer-b' : ''}`,
      );
    }
    for (const f of [null, fil]) {
      const p = { pair: 'peer-b', kind: 'answer' as const, texte, fil: f };
      expect(argvEcriture('dm.envoyer', p, 'peer-a')).toEqual([
        'mesh',
        'send',
        'peer-b',
        '--kind',
        'answer',
        '--content-file',
        'FICHIER',
        ...(f ? ['--thread', f] : []),
        '--as',
        'peer-a',
      ]);
      expect(resumeEcriture('dm.envoyer', p)).toBe(`DM answer à peer-b${f ? ', dans un fil' : ''}`);
    }
    const p = { canal: 'general', kind: 'fyi' as const, texte };
    expect(argvEcriture('canal.poster', p, 'peer-a')).toEqual([
      'channel',
      'post',
      'general',
      '--kind',
      'fyi',
      '--content-file',
      'FICHIER',
      '--as',
      'peer-a',
    ]);
    expect(resumeEcriture('canal.poster', p)).toBe('Post fyi sur le canal general');
    expect(resumeEcriture('canal.poster', p)).not.toContain(texte);
    expect(
      resumeEcriture('canal.poster', { ...p, canal: 'a'.repeat(63) }).length,
    ).toBeLessThanOrEqual(160);
  });
  const bases = {
    'carte.note': { carte: 1, kind: 'fyi', texte, a: null },
    'dm.envoyer': { pair: 'peer-b', kind: 'answer', texte, fil: null },
    'canal.poster': { canal: 'general', kind: 'status', texte },
  };
  for (const action of Object.keys(bases) as ActionEcriture[]) {
    it(`ferme le schéma ${action}`, () => {
      const base = bases[action];
      expect(lireParamsEcriture(action, base, 'peer-a').ok).toBe(true);
      for (const brut of [
        null,
        [],
        1,
        { ...base, surplus: true },
        ...Object.keys(base).map((cle) =>
          Object.fromEntries(Object.entries(base).filter(([k]) => k !== cle)),
        ),
        ...['', ' ', 'x'.repeat(4001), 'a\r', 'a\0', 'a\u0085', 42].map((texte) => ({
          ...base,
          texte,
        })),
        ...['autre', null, 1].map((kind) => ({ ...base, kind })),
      ])
        expect(lireParamsEcriture(action, brut, 'peer-a').ok).toBe(false);
      expect(lireParamsEcriture(action, { ...base, texte: 'oui\n\t😀' }, 'peer-a').ok).toBe(true);
    });
  }
  it('refuse les cibles, cartes et fils invalides', () => {
    for (const carte of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1, '1'])
      expect(lireParamsEcriture('carte.note', { ...bases['carte.note'], carte }, 'peer-a').ok).toBe(
        false,
      );
    for (const nom of ['', '-a', 'A', 'a_b', 'a'.repeat(64), 'peer-b\n', 1]) {
      expect(
        lireParamsEcriture('carte.note', { ...bases['carte.note'], a: nom }, 'peer-a').ok,
      ).toBe(false);
      expect(
        lireParamsEcriture('dm.envoyer', { ...bases['dm.envoyer'], pair: nom }, 'peer-a').ok,
      ).toBe(false);
      expect(
        lireParamsEcriture('canal.poster', { ...bases['canal.poster'], canal: nom }, 'peer-a').ok,
      ).toBe(false);
    }
    for (const fil of ['', 'invalide', 42])
      expect(lireParamsEcriture('dm.envoyer', { ...bases['dm.envoyer'], fil }, 'peer-a').ok).toBe(
        false,
      );
    expect(
      lireParamsEcriture('dm.envoyer', { ...bases['dm.envoyer'], pair: 'peer-a' }, 'peer-a').ok,
    ).toBe(false);
    expect(lireParamsEcriture('inconnue' as ActionEcriture, {}, 'peer-a').ok).toBe(false);
  });
  it('lit le rappel et interdit toute clôture', () => {
    expect(lireReponseEcriture({ id: 1, open_obligations: [21], closed_obligations: [] })).toEqual({
      ok: true,
      id: 1,
      open_obligations: [21],
      closed_obligations: [],
    });
    expect(lireReponseEcriture({ id: 1, open_obligations: [], closed_obligations: [22] })).toEqual({
      ok: false,
      kind: 'obligation-close',
      ids: [22],
    });
    for (const brut of [
      null,
      [],
      {},
      { id: '1', open_obligations: [], closed_obligations: [] },
      { id: 1, open_obligations: ['21'], closed_obligations: [] },
      { id: 1, open_obligations: [], closed_obligations: ['22'] },
    ])
      expect(lireReponseEcriture(brut)).toEqual({ ok: false, kind: 'format' });
  });
});
