import { describe, expect, it } from 'vitest';
import {
  hashAccept,
  ISSUES_CLOTURE,
  lireParamsEtat,
  resumeEtat,
  textesAPurger,
  type ActionEtat,
} from '../../src/shared/etats.js';
import { nettoyer } from '../../src/shared/nettoyage.js';
const cible = { carte: 1457, obligation: 81, attendu: { status: 'open' as const } };
const fermeture = {
  ...cible,
  attendu: { status: 'open' as const, acceptSha256: 'a'.repeat(64) },
  issue: 'pass' as const,
  preuve: 'Vérification effectuée',
};
const actions: ActionEtat[] = ['obligation.prendre', 'obligation.refuser', 'obligation.clore'];
describe('états', () => {
  // Fixtures calculées séparément avec hashlib.sha256 (Python), en UTF-8.
  it.each([
    [null, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['accept', 'c125d0397b605657bc89340953f5f2897a7e00a9b7d3474fa53720c8ccbbb3e3'],
    ['État vérifié', 'f64104134a16e3010311e3480bcff9c24a7dbcafb2a464dc85c583be658eac73'],
    ['accept\n', 'a7569daef68e7aa91f0cc9856e2461c5cb2bd5494eaf28818c3e059972d987e5'],
    ['  accept', '6c79dc746e4fd89a1f6073fd143d25eb60c2cdc61723db69e809f8b62648615a'],
  ])('fige le hash de %j', async (texte, hash) => {
    expect(await hashAccept(texte)).toBe(hash);
  });
  it('ne normalise ni espaces ni Unicode', async () => {
    expect(await hashAccept('accept')).not.toBe(await hashAccept('accept '));
    expect(await hashAccept('é')).not.toBe(await hashAccept('e\u0301'));
    expect(await hashAccept('')).toBe(await hashAccept(null));
  });
  for (const action of actions) {
    it(`ferme le schéma ${action} et nomme le premier refus`, () => {
      const base = action === 'obligation.clore' ? fermeture : cible;
      const refuser = (brut: unknown, message?: string) => {
        const resultat = lireParamsEtat(action, brut);
        if (message) expect(resultat).toEqual({ ok: false, message });
        else expect(resultat.ok).toBe(false);
      };
      expect(lireParamsEtat(action, base)).toEqual({ ok: true, params: base });
      for (const brut of [null, [], 42, 'texte']) refuser(brut, 'params doit être un objet');
      refuser({ ...base, surplus: true }, 'clé inconnue : surplus');
      refuser({ ...base, [Symbol('surplus')]: true });
      for (const champ of Object.keys(base).filter((cle) => cle !== 'preuve'))
        refuser(
          Object.fromEntries(Object.entries(base).filter(([cle]) => cle !== champ)),
          `champ manquant : ${champ}`,
        );
      for (const champ of ['carte', 'obligation']) {
        for (const valeur of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, '1', null])
          refuser({ ...base, [champ]: valeur });
      }
      refuser({ ...base, carte: 0, obligation: 0 }, 'numéro de carte invalide');
      refuser({ ...base, obligation: 0 }, 'numéro d’obligation invalide');
      for (const attendu of [null, [], 42])
        refuser({ ...base, attendu }, 'attendu doit être un objet');
      refuser({ ...base, attendu: {} }, 'champ manquant : attendu.status');
      for (const status of ['closed', '', '  ', null, 1])
        refuser(
          { ...base, attendu: { ...base.attendu, status } },
          'attendu.status doit valoir open',
        );
      refuser(
        { ...base, attendu: { ...base.attendu, surplus: true } },
        'clé inconnue dans attendu : surplus',
      );
      refuser({ ...base, attendu: { ...base.attendu, [Symbol('x')]: 1 } });
      if (action !== 'obligation.clore') {
        for (const champ of ['preuve', 'preuves', 'issue']) refuser({ ...base, [champ]: 'x' });
        refuser({ ...base, attendu: fermeture.attendu });
      }
    });
  }
  it('valide tous les champs de clôture et leurs limites', () => {
    const lire = (changement: Record<string, unknown>) =>
      lireParamsEtat('obligation.clore', { ...fermeture, ...changement });
    expect(lireParamsEtat('inconnue' as ActionEtat, {})).toEqual({
      ok: false,
      message: 'action inconnue',
    });
    expect(lire({ attendu: cible.attendu })).toEqual({
      ok: false,
      message: 'champ manquant : attendu.acceptSha256',
    });
    for (const hash of [
      null,
      42,
      '',
      'A'.repeat(64),
      'g'.repeat(64),
      'a'.repeat(63),
      'a'.repeat(65),
      'a'.repeat(64) + '\n',
    ])
      expect(lire({ attendu: { status: 'open', acceptSha256: hash } })).toEqual({
        ok: false,
        message: 'attendu.acceptSha256 invalide',
      });
    for (const issue of ISSUES_CLOTURE) expect(lire({ issue }).ok).toBe(true);
    for (const issue of [null, '', 'autre', 1])
      expect(lire({ issue })).toEqual({ ok: false, message: 'issue inconnue' });
    const sansPreuve = { ...cible, attendu: fermeture.attendu, issue: fermeture.issue };
    expect(lireParamsEtat('obligation.clore', sansPreuve)).toEqual({
      ok: false,
      message: 'preuve ou preuves requise',
    });
    expect(lireParamsEtat('obligation.clore', { ...sansPreuve, preuves: {} }).ok).toBe(false);
    expect(lire({ preuves: {} }).ok).toBe(true);
    for (const [texte, motif] of [
      [42, 'invalide'],
      [undefined, 'invalide'],
      ['', 'vide'],
      [' \n\t', 'vide'],
      ['x'.repeat(4001), 'trop longue (4 000 caractères au plus)'],
      ['a\r', 'contenant un caractère de contrôle'],
      ['a\0', 'contenant un caractère de contrôle'],
      ['a\u0085', 'contenant un caractère de contrôle'],
    ] as const) {
      expect(lire({ preuve: texte })).toEqual({ ok: false, message: `preuve ${motif}` });
      expect(lire({ preuves: { condition: texte } })).toEqual({
        ok: false,
        message: `texte de preuves ${motif}`,
      });
    }
    for (const preuve of ['x', '😀'.repeat(4000), 'oui\n\t'])
      expect(lire({ preuve }).ok).toBe(true);
    for (const preuves of [null, [], 1, 'texte'])
      expect(lire({ preuves })).toEqual({ ok: false, message: 'preuves doit être un objet' });
    for (const cle of ['', 'a'.repeat(65), 'a b', 'é', 'a\n'])
      expect(lire({ preuves: { [cle]: 'oui' } })).toEqual({
        ok: false,
        message: 'identifiant de condition invalide',
      });
    expect(lire({ preuves: { [Symbol('x')]: 'oui' } }).ok).toBe(false);
    const preuves = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`condition-${i}`, 'oui']),
    );
    expect(lire({ preuves }).ok).toBe(true);
    expect(lire({ preuves: { ...preuves, autre: 'oui' } })).toEqual({
      ok: false,
      message: 'preuves : 20 conditions au plus',
    });
    expect(
      lireParamsEtat('obligation.clore', {
        ...sansPreuve,
        preuves: { 'A_0.:-': 'oui', ['a'.repeat(64)]: 'oui' },
      }).ok,
    ).toBe(true);
  });
  it('résume sans aucune preuve, même aux limites numériques', () => {
    for (const [action, verbe] of [
      ['obligation.prendre', 'Prendre'],
      ['obligation.refuser', 'Refuser'],
      ['obligation.clore', 'Clore'],
    ] as const) {
      const params = { ...fermeture, preuves: { condition: 'Preuve confidentielle distincte' } };
      const base = action === 'obligation.clore' ? params : cible;
      const resume = resumeEtat(action, base);
      expect(resume).toBe(
        `${verbe} l'obligation #81 (carte #1457)${action === 'obligation.clore' ? ' : pass' : ''}`,
      );
      for (const texte of textesAPurger(base)) expect(resume).not.toContain(texte);
      expect(
        resumeEtat(action, {
          ...base,
          carte: Number.MAX_SAFE_INTEGER,
          obligation: Number.MAX_SAFE_INTEGER,
        }).length,
      ).toBeLessThanOrEqual(160);
    }
    expect(() => resumeEtat('obligation.prendre', { ...cible, carte: 0 })).toThrow(
      'Paramètres d’état invalides',
    );
  });
  it('extrait tous les textes sans les nettoyer ni les modifier', () => {
    expect(textesAPurger(cible)).toEqual([]);
    expect(textesAPurger(fermeture)).toEqual([fermeture.preuve]);
    const preuves = { a: '  preuve\n', b: 'aid-e2e.ts.net' };
    const sansPreuve = { ...cible, attendu: fermeture.attendu, issue: fermeture.issue };
    expect(textesAPurger({ ...sansPreuve, preuves })).toEqual(Object.values(preuves));
    const textes = textesAPurger({ ...fermeture, preuves });
    expect(textes).toEqual([fermeture.preuve, ...Object.values(preuves)]);
    expect(textes.map((texte) => nettoyer(texte).ok)).toEqual([true, true, false]);
  });
});
