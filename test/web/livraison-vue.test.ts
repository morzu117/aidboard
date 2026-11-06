import { expect, test } from 'vitest';
import type { ActionRun } from '../../src/shared/model.js';
import {
  blocageMerge,
  citations,
  compterControles,
  fraicheurRevue,
  libelleFraicheur,
  lireAvis,
  lireControles,
  lirePr,
  messageRevue,
  sourceRevue,
} from '../../web/src/ui/livraisonVue.js';

const TETE = '3f2a91c0000000000000000000000000000000aa';
const AVANT = '0dd8bb40000000000000000000000000000000bb';

const pr = (over: Record<string, unknown> = {}) =>
  lirePr({
    number: 7,
    url: 'https://github.com/test/test/pull/7',
    state: 'OPEN',
    headRefOid: TETE,
    baseRefName: 'main',
    mergeable: 'MERGEABLE',
    statusCheckRollup: [],
    reviews: [],
    ...over,
  });

const run = (over: Partial<ActionRun> = {}): ActionRun => ({
  id: 'ac_1',
  topicId: 'tp_1',
  workspaceId: 'ws_1',
  action: 'topic.test',
  state: 'succeeded',
  exitCode: 0,
  result: { head: TETE },
  startedAt: '2026-11-06T10:00:00.000Z',
  finishedAt: '2026-11-06T10:00:41.000Z',
  ...over,
});

test('D124 : la PR relue, validée champ par champ', () => {
  expect(lirePr(null)).toBeNull();
  const p = lirePr({ number: 'x', state: 'DRAFT', mergeable: 'OUI', statusCheckRollup: 'non' })!;
  expect(p).toMatchObject({ number: null, state: null, mergeable: null, headRefOid: null });
  expect(p.checks).toEqual([]);
  expect(pr()?.headRefOid).toBe(TETE);
});

test('D130 : contrôles GitHub et test local, chacun sur sa tête', () => {
  const p = pr({
    statusCheckRollup: [
      {
        __typename: 'CheckRun',
        name: 'gate (node 22)',
        status: 'COMPLETED',
        conclusion: 'SUCCESS',
        startedAt: '2026-11-06T10:00:00Z',
        completedAt: '2026-11-06T10:03:00Z',
        detailsUrl: 'https://ci/1',
      },
      { __typename: 'CheckRun', name: 'labo', status: 'IN_PROGRESS', conclusion: '' },
      { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE' },
      { __typename: 'CheckRun', name: 'facultatif', status: 'COMPLETED', conclusion: 'SKIPPED' },
      { __typename: 'StatusContext', context: 'ci/ext', state: 'ERROR', targetUrl: 'https://x' },
      { __typename: 'StatusContext', context: 'ci/attente', state: 'PENDING' },
      'bruit',
    ],
  });
  const cs = lireControles(p, run());
  expect(cs.map((c) => [c.nom, c.etat])).toEqual([
    ['gate (node 22)', 'succes'],
    ['labo', 'en-cours'],
    ['lint', 'panne'],
    ['facultatif', 'succes'],
    ['ci/ext', 'panne'],
    ['ci/attente', 'en-cours'],
    ['npm test (local)', 'succes'],
  ]);
  expect(cs[0]).toMatchObject({ tete: TETE, dureeS: 180, url: 'https://ci/1', local: false });
  expect(cs[4]?.url).toBe('https://x');
  expect(cs.at(-1)).toMatchObject({ tete: TETE, dureeS: 41, local: true });
  expect(compterControles(cs, TETE)).toEqual({ total: 7, passes: 3, pannes: 2, enCours: 2 });
});

test('D130 : un test local sur une autre tête ne compte pas ; en cours, en échec', () => {
  const cs = lireControles(null, run({ result: { head: AVANT } }));
  expect(compterControles(cs, TETE).total).toBe(0);
  expect(lireControles(null, run({ state: 'running', finishedAt: null }))[0]?.etat).toBe(
    'en-cours',
  );
  expect(lireControles(null, run({ state: 'failed', exitCode: 1 }))[0]?.etat).toBe('panne');
  expect(lireControles(null, run({ result: null }))[0]?.tete).toBeNull();
  expect(compterControles(cs, null).total).toBe(0);
});

test('D126 : la source de la revue, page d’abord, puis GitHub', () => {
  expect(sourceRevue(null, [])).toBeNull();
  expect(sourceRevue({ frontmatter: { commit: ` ${AVANT} ` }, body: '' }, [])).toEqual({
    origine: 'page',
    commit: AVANT,
    auteur: null,
  });
  expect(sourceRevue({ frontmatter: {}, body: 'commit: 0dd8bb4\n\nTexte' }, [])?.commit).toBe(
    '0dd8bb4',
  );
  expect(sourceRevue({ frontmatter: {}, body: 'Rien' }, [])?.commit).toBeNull();
  const gh = [
    { author: { login: 'a' }, commit: { oid: AVANT } },
    { author: { login: 'codex' }, commit: { oid: TETE } },
  ];
  expect(sourceRevue(null, gh)).toEqual({ origine: 'github', commit: TETE, auteur: 'codex' });
});

test('D126 : fraîcheur et libellés', () => {
  const src = { origine: 'page' as const, commit: AVANT, auteur: null };
  expect(fraicheurRevue(null, null)).toEqual({ etat: 'aucune' });
  expect(fraicheurRevue({ ...src, commit: null }, null)).toEqual({ etat: 'sans-tete' });
  expect(fraicheurRevue(src, { connu: true, ancetre: true, retard: 0 }).etat).toBe('a-jour');
  const vieille = fraicheurRevue(src, { connu: true, ancetre: true, retard: 1 });
  expect(vieille).toEqual({ etat: 'obsolete', commit: AVANT, retard: 1 });
  expect(libelleFraicheur(vieille)).toEqual({
    titre: 'Obsolète',
    note: 'Porte sur 0dd8bb4 · 1 commit de retard',
  });
  expect(libelleFraicheur({ etat: 'obsolete', commit: AVANT, retard: 3 }).note).toContain(
    '3 commits de retard',
  );
  const perdue = fraicheurRevue(src, { connu: true, ancetre: false, retard: 0 });
  expect(libelleFraicheur(perdue).note).toBe('Porte sur 0dd8bb4, absent de la branche');
  expect(fraicheurRevue(src, { connu: false, ancetre: false, retard: 0 }).etat).toBe('obsolete');
  expect(fraicheurRevue(src, null).etat).toBe('obsolete');
  expect(libelleFraicheur({ etat: 'a-jour', commit: TETE }).titre).toBe('À jour');
  expect(libelleFraicheur({ etat: 'aucune' }).titre).toBe('Aucune revue');
  expect(libelleFraicheur({ etat: 'sans-tete' }).titre).toBe('Revue sans tête connue');
});

test('D127 : une seule raison de blocage, dans l’ordre', () => {
  const base = {
    fusionne: false,
    aPr: true,
    pr: pr(),
    teteLocale: TETE,
    fraicheur: { etat: 'aucune' } as const,
  };
  expect(blocageMerge(base)).toBeNull();
  expect(blocageMerge({ ...base, fusionne: true, teteLocale: AVANT })).toBe(
    'le sujet est déjà fusionné.',
  );
  expect(blocageMerge({ ...base, pr: pr({ state: 'MERGED' }) })).toBe(
    'le sujet est déjà fusionné.',
  );
  expect(blocageMerge({ ...base, pr: pr({ state: 'CLOSED' }) })).toBe('la PR est fermée.');
  expect(blocageMerge({ ...base, aPr: false, pr: null })).toBe('aucune PR ouverte.');
  expect(blocageMerge({ ...base, pr: null })).toBe('la PR n’est pas encore relue.');
  expect(blocageMerge({ ...base, teteLocale: AVANT })).toBe(
    'la tête locale 0dd8bb4 n’est pas sur la PR.',
  );
  expect(blocageMerge({ ...base, teteLocale: null })).toBe('la tête locale est inconnue.');
  expect(
    blocageMerge({
      ...base,
      pr: pr({ mergeable: 'CONFLICTING' }),
      fraicheur: { etat: 'obsolete', commit: AVANT, retard: 1 },
    }),
  ).toBe('la revue ne porte pas sur cette tête.');
  expect(blocageMerge({ ...base, pr: pr({ mergeable: 'CONFLICTING' }) })).toBe(
    'GitHub signale un conflit avec la base.',
  );
  expect(blocageMerge({ ...base, fraicheur: { etat: 'sans-tete' } })).toBeNull();
});

test('D127 : ce qui est cité sans bloquer', () => {
  const zero = { total: 0, passes: 0, pannes: 0, enCours: 0 };
  expect(citations({ etat: 'a-jour', commit: TETE }, zero)).toEqual([]);
  expect(citations({ etat: 'aucune' }, { ...zero, pannes: 1, enCours: 2 })).toEqual([
    'Aucune revue',
    '1 contrôle en panne',
    '2 contrôles en cours',
  ]);
  expect(citations({ etat: 'sans-tete' }, zero)).toEqual(['Revue sans tête connue']);
});

test('D131 : l’avis lu dans la page', () => {
  const body = [
    '## Revue de 3f2a91c',
    'commit: 3f2a91c',
    '',
    'On peut livrer :   le diff tient,',
    'les tests sont verts.',
    '',
    '- Examiné : 24 fichiers du diff.',
    '- Non examiné : recette Databricks, performances.',
  ].join('\n');
  expect(lireAvis(body)).toEqual({
    texte: 'On peut livrer : le diff tient, les tests sont verts.',
    examine: '24 fichiers du diff.',
    nonExamine: 'recette Databricks, performances.',
  });
  expect(lireAvis('')).toEqual({ texte: null, examine: null, nonExamine: null });
  const long = lireAvis('x'.repeat(400)).texte!;
  expect(long).toHaveLength(300);
  expect(long.endsWith('…')).toBe(true);
});

test('D129 : le message de revue nomme la page, la tête et la base', () => {
  const m = messageRevue({ page: 'aid/review/livraison', mergeBase: AVANT, tete: TETE });
  expect(m).toContain(`git diff ${AVANT}...${TETE}`);
  expect(m).toContain(`aid/review/livraison, avec dans son frontmatter « commit: ${TETE} »`);
  expect(m).toContain('Ne modifie aucun fichier');
  expect(m).toContain('« Examiné : … »');
  expect(m.length).toBeLessThan(4000);
});
