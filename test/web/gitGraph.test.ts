import { describe, expect, test } from 'vitest';
import type { GitLogCommit } from '../../src/shared/git.js';
import { assignLanes, findRefTip, layoutGraph } from '../../web/src/ui/gitGraph.js';

// Scénario de design/aid-export-git-flow (écran 3.2, état default) : la branche du sujet
// (c2, c3) est partie de c8, main (base) a reçu la fusion d'une autre branche (c4, second
// parent c5 → c7) après coup, puis continue tout droit vers c8 (c6) → c9 → c10.
function commit(
  hash: string,
  parents: string[],
  inHead: boolean,
  refs: string[] = [],
): GitLogCommit {
  return {
    hash,
    parents,
    author: 'test',
    date: '2026-01-01T00:00:00Z',
    message: hash,
    refs,
    inHead,
  };
}

const COMMITS: GitLogCommit[] = [
  commit('c2', ['c3'], true, ['HEAD', 'feat/x']),
  commit('c3', ['c8'], true, ['origin/feat/x']),
  commit('c4', ['c6', 'c5'], false, ['main', 'origin/main']),
  commit('c5', ['c7'], false, ['feat/temoin']),
  commit('c6', ['c8'], false),
  commit('c7', ['c8'], false),
  commit('c8', ['c9'], true),
  commit('c9', ['c10'], true),
  commit('c10', [], true),
];

describe('assignLanes', () => {
  test('voie 0 (mainline) suit le premier parent depuis la base, voie 2 pour la branche fusionnée', () => {
    const baseTip = findRefTip(COMMITS, ['origin/main', 'main']);
    expect(baseTip).toBe('c4');
    const lanes = assignLanes(COMMITS, baseTip);
    expect([...lanes.entries()]).toEqual(
      expect.arrayContaining([
        ['c2', 1],
        ['c3', 1],
        ['c4', 0],
        ['c5', 2],
        ['c6', 0],
        ['c7', 2],
        ['c8', 0],
        ['c9', 0],
        ['c10', 0],
      ]),
    );
  });

  test('sans pointe de base visible, tout ce qui est atteignable depuis HEAD reste voie 1', () => {
    const lanes = assignLanes(COMMITS, null);
    expect(lanes.get('c2')).toBe(1);
    expect(lanes.get('c3')).toBe(1);
    expect(lanes.get('c5')).toBe(2);
  });
});

describe('layoutGraph', () => {
  const rows = layoutGraph(COMMITS, { baseRefs: ['origin/main', 'main'], dirty: false });

  test('une ligne par commit, dans le même ordre, HEAD repéré', () => {
    expect(rows.map((r) => r.hash)).toEqual(COMMITS.map((c) => c.hash));
    expect(rows[0]).toMatchObject({ hash: 'c2', isHead: true, lane: 1, absent: false });
  });

  test('les commits non atteignables depuis HEAD sont marqués absents', () => {
    expect(rows.find((r) => r.hash === 'c4')?.absent).toBe(true);
    expect(rows.find((r) => r.hash === 'c8')?.absent).toBe(false);
  });

  test('le départ de branche c3→c8 passe en trait voie 1 à travers les lignes intermédiaires', () => {
    const intermediate = ['c4', 'c5', 'c6', 'c7'].map((h) => rows.find((r) => r.hash === h)!);
    for (const row of intermediate) {
      expect(row.paths.some((p) => p.lane === 1 && p.d === 'M 32 0 L 32 32')).toBe(true);
    }
    const c8 = rows.find((r) => r.hash === 'c8')!;
    expect(c8.paths).toContainEqual({ d: 'M 32 0 C 32 16 14 0 14 16', lane: 1, dashed: false });
  });

  test('la fusion (second parent) c4→c5 colore la courbe avec la voie du parent', () => {
    const c4 = rows.find((r) => r.hash === 'c4')!;
    expect(c4.paths).toContainEqual({
      d: 'M 14 16 C 14 32 50 16 50 32',
      lane: 2,
      dashed: false,
    });
  });

  test('avec des modifications non commitées, une ligne WIP pointillée précède HEAD', () => {
    const withWip = layoutGraph(COMMITS, { baseRefs: ['origin/main', 'main'], dirty: true });
    expect(withWip[0]).toMatchObject({ hash: '', wip: true, lane: 1 });
    expect(withWip[0]!.paths[0]).toMatchObject({ dashed: true });
    const head = withWip.find((r) => r.hash === 'c2')!;
    expect(head.paths.some((p) => p.dashed)).toBe(true);
  });

  test('décoration réelle de git, `HEAD -> <branche>` : HEAD repéré et ligne WIP (onglet Git d’un sujet)', () => {
    const decores = COMMITS.map((c) => (c.hash === 'c2' ? { ...c, refs: ['HEAD -> feat/x'] } : c));
    const rows = layoutGraph(decores, { baseRefs: ['origin/main', 'main'], dirty: true });
    expect(rows[0]).toMatchObject({ hash: '', wip: true, lane: 1 });
    expect(rows.filter((r) => r.isHead).map((r) => r.hash)).toEqual(['c2']);
    // la branche reste une ref à part entière : base sur une branche courante
    expect(findRefTip(decores, ['feat/x'])).toBe('c2');
    const surMain = COMMITS.map((c) =>
      c.hash === 'c4' ? { ...c, refs: ['HEAD -> main', 'origin/main'] } : c,
    );
    expect(findRefTip(surMain, ['main'])).toBe('c4');
  });
});
