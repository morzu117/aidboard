import type { GitLogCommit } from '../../../src/shared/git.js';

// 11.3 (D24) : reconstruction du graphe git côté client, à partir des seuls parents et refs
// renvoyés par le serveur — algorithme de design/aid-export-git-flow/README.md § « Graphe git ».
// Jamais de géométrie côté serveur : ce module est la seule source de vérité pour les voies.

export type Lane = 0 | 1 | 2;

export const LANE_X: Record<Lane, number> = { 0: 14, 1: 32, 2: 50 };
export const ROW_HEIGHT = 32;
export const NODE_Y = 16;

export interface GraphPath {
  d: string;
  lane: Lane;
  dashed: boolean;
}

export interface GraphRow {
  hash: string;
  lane: Lane;
  isHead: boolean;
  wip: boolean;
  absent: boolean;
  paths: GraphPath[];
  rowHeight: number;
  nodeY: number;
}

// Le commit dont les refs portent `origin/<base>` (ou `<base>` sans remote) : départ du fil
// « premier parent » qui définit la voie 0. `null` si la base n'apparaît pas dans la fenêtre.
// `git log` décore la branche courante `HEAD -> <branche>` : ce commit est à la fois `HEAD` et
// `<branche>`. Sans ce dépliage, ni nœud courant ni ligne WIP dans l'onglet Git d'un sujet.
const refNames = (r: string) => (r.startsWith('HEAD -> ') ? ['HEAD', r.slice(8)] : [r]);
export function findRefTip(commits: GitLogCommit[], candidates: string[]): string | null {
  for (const c of commits)
    if (c.refs.some((r) => refNames(r).some((n) => candidates.includes(n)))) return c.hash;
  return null;
}

function walkAllParents(start: string | null, byHash: Map<string, GitLogCommit>): Set<string> {
  const seen = new Set<string>();
  const stack = start ? [start] : [];
  while (stack.length > 0) {
    const hash = stack.pop()!;
    if (seen.has(hash) || !byHash.has(hash)) continue;
    seen.add(hash);
    stack.push(...byHash.get(hash)!.parents);
  }
  return seen;
}

function walkFirstParent(start: string | null, byHash: Map<string, GitLogCommit>): Set<string> {
  const seen = new Set<string>();
  let cursor = start;
  while (cursor && byHash.has(cursor) && !seen.has(cursor)) {
    seen.add(cursor);
    cursor = byHash.get(cursor)!.parents[0] ?? null;
  }
  return seen;
}

// Voie 0 (mainline) : fil premier-parent depuis la pointe de la base.
// Voie 2 (fusionnée) : atteignable depuis la base, mais pas par ce fil (branche mergée).
// Voie 1 (sujet) : atteignable depuis HEAD (`inHead`, D24) et pas déjà classé ci-dessus.
// Voie 2 (autre) : le reste de la fenêtre partagée.
export function assignLanes(
  commits: GitLogCommit[],
  baseTipHash: string | null,
): Map<string, Lane> {
  const byHash = new Map(commits.map((c) => [c.hash, c]));
  const mainline = walkFirstParent(baseTipHash, byHash);
  const reachableFromBase = walkAllParents(baseTipHash, byHash);
  const lanes = new Map<string, Lane>();
  for (const c of commits) {
    if (mainline.has(c.hash)) lanes.set(c.hash, 0);
    else if (reachableFromBase.has(c.hash)) lanes.set(c.hash, 2);
    else if (c.inHead) lanes.set(c.hash, 1);
    else lanes.set(c.hash, 2);
  }
  return lanes;
}

interface Node {
  hash: string;
  lane: Lane;
  parents: string[];
}

// Construit les tracés SVG : parcourt chaque arête commit → parent et ajoute un segment à
// chaque ligne traversée (y compris les lignes intermédiaires, qui appartiennent souvent à une
// autre voie — c'est ce qui donne les traits qui « passent au travers » dans l'export).
function buildPaths(
  nodes: Node[],
  dashedFrom: Set<string>,
  rowHeight: number,
  nodeY: number,
): GraphPath[][] {
  const index = new Map(nodes.map((n, i) => [n.hash, i]));
  const rows: GraphPath[][] = nodes.map(() => []);
  const mid = (lane: Lane) => `${LANE_X[lane]} ${nodeY}`;
  const top = (lane: Lane) => `${LANE_X[lane]} 0`;
  const bottom = (lane: Lane) => `${LANE_X[lane]} ${rowHeight}`;
  const add = (row: number, d: string, lane: Lane, dashed: boolean) =>
    rows[row]!.push({ d, lane, dashed });

  for (let i = 0; i < nodes.length; i++) {
    const commit = nodes[i]!;
    const dashed = dashedFrom.has(commit.hash);
    for (const [pi, parentHash] of commit.parents.entries()) {
      const j = index.get(parentHash);
      if (j === undefined) continue; // parent hors fenêtre : le trait s'arrête ici.
      const parentLane = nodes[j]!.lane;
      const sameLane = parentLane === commit.lane;
      const mergeSecondParent = pi > 0 && !sameLane;
      if (sameLane) {
        add(i, `M ${mid(commit.lane)} L ${bottom(commit.lane)}`, commit.lane, dashed);
        for (let r = i + 1; r < j; r++) {
          add(r, `M ${top(commit.lane)} L ${bottom(commit.lane)}`, commit.lane, false);
        }
        add(j, `M ${top(parentLane)} L ${mid(parentLane)}`, parentLane, dashed);
      } else if (mergeSecondParent) {
        add(
          i,
          `M ${mid(commit.lane)} C ${LANE_X[commit.lane]} ${rowHeight} ${LANE_X[parentLane]} ${nodeY} ${bottom(parentLane)}`,
          parentLane,
          false,
        );
        for (let r = i + 1; r < j; r++) {
          add(r, `M ${top(parentLane)} L ${bottom(parentLane)}`, parentLane, false);
        }
        add(j, `M ${top(parentLane)} L ${mid(parentLane)}`, parentLane, false);
      } else {
        // Départ de branche : voie du commit jusqu'à la ligne du parent, puis courbe vers son nœud.
        add(i, `M ${mid(commit.lane)} L ${bottom(commit.lane)}`, commit.lane, dashed);
        for (let r = i + 1; r < j; r++) {
          add(r, `M ${top(commit.lane)} L ${bottom(commit.lane)}`, commit.lane, false);
        }
        add(
          j,
          `M ${top(commit.lane)} C ${LANE_X[commit.lane]} ${nodeY} ${LANE_X[parentLane]} 0 ${mid(parentLane)}`,
          commit.lane,
          false,
        );
      }
    }
  }
  return rows;
}

export function layoutGraph(
  commits: GitLogCommit[],
  opts: { baseRefs: string[]; dirty: boolean; rowHeight?: number; nodeY?: number },
): GraphRow[] {
  const rowHeight = opts.rowHeight ?? ROW_HEIGHT;
  const nodeY = opts.nodeY ?? NODE_Y;
  const lanes = assignLanes(commits, findRefTip(commits, opts.baseRefs));
  const headHash = findRefTip(commits, ['HEAD']);
  const nodes: Node[] = commits.map((c) => ({
    hash: c.hash,
    lane: lanes.get(c.hash) ?? 2,
    parents: c.parents,
  }));
  const dashedFrom = new Set<string>();
  if (opts.dirty && headHash) {
    nodes.unshift({ hash: '', lane: lanes.get(headHash) ?? 1, parents: [headHash] });
    dashedFrom.add('');
  }
  const paths = buildPaths(nodes, dashedFrom, rowHeight, nodeY);
  const byHash = new Map(commits.map((c) => [c.hash, c]));
  return nodes.map((n, i) => ({
    hash: n.hash,
    lane: n.lane,
    isHead: n.hash === headHash,
    wip: n.hash === '',
    absent: n.hash === '' ? false : !(byHash.get(n.hash)?.inHead ?? false),
    paths: paths[i]!,
    rowHeight,
    nodeY,
  }));
}
