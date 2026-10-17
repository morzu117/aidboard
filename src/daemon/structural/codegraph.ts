import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
  Capability,
  IndexStatus,
  Provenance,
  Relation,
  SymbolRef,
} from '../../shared/structural.js';
import { StructuralUnavailable } from '../../shared/structural.js';
import { run } from './exec.js';
import type { StructuralIndex } from './types.js';

const CAPABILITIES: Capability[] = ['explore', 'symbols', 'callers', 'impact', 'affected'];

// Un seul moteur aujourd'hui : tree-sitter, jamais de type-checker — toute relation qu'il rend
// est `candidate` (DS3 du plan), jamais `exact`.
const PROVENANCE: Provenance = 'candidate';

interface CodegraphNode {
  name: string;
  kind: string;
  filePath: string;
  startLine: number;
}
interface CodegraphQueryHit {
  node: CodegraphNode;
}
interface CodegraphStatus {
  initialized: boolean;
  version?: string;
  lastIndexed?: string | null;
  fileCount?: number;
  nodeCount?: number;
  languages?: string[];
  pendingChanges?: { added?: number; modified?: number; removed?: number };
  index?: { builtWithVersion?: string };
  // Présent (souvent `null`) sur le `status -j` réel : forme exacte non documentée par
  // codegraph, donc traité par simple troncature de vérité plutôt que parsé en détail.
  worktreeMismatch?: unknown;
}
interface CodegraphCallers {
  callers: CodegraphNode[];
}
interface CodegraphImpact {
  affected: CodegraphNode[];
}
interface CodegraphAffected {
  affectedTests: string[];
}

function toSymbol(n: CodegraphNode): SymbolRef {
  return { name: n.name, kind: n.kind, file: n.filePath, line: n.startLine };
}

// DO2 (chantier 08) : aucune sous-commande codegraph ne lit de liste d'exclusion (vérifié sur
// `--help` de query/callers/impact/affected/explore) — le contrat prévoit que l'adaptateur la
// fasse respecter comme il peut, donc en filtrant les résultats après coup. Une entrée ("dist")
// exclut tout fichier dont un segment de chemin la matche exactement.
export function isExcluded(file: string, exclude: readonly string[]): boolean {
  return exclude.length > 0 && file.split('/').some((segment) => exclude.includes(segment));
}

// `status` est la seule sous-commande de codegraph dont le chemin est positionnel : toutes les
// autres (query/callers/impact/affected/explore) prennent -p/--path. Vérifié directement sur
// le CLI installé (codegraph <cmd> --help), pas une supposition du plan.
export class CodegraphIndex implements StructuralIndex {
  readonly engine = 'codegraph' as const;

  constructor(
    private readonly bin: string,
    private readonly timeoutMs = 60_000,
    private readonly exclude: readonly string[] = [],
  ) {}

  detect(root: string): boolean {
    return existsSync(join(root, '.codegraph'));
  }

  init(root: string, log: number): ChildProcess {
    return spawn(this.bin, ['init', '-y', root], { cwd: root, stdio: ['ignore', log, log] });
  }

  async status(root: string): Promise<IndexStatus> {
    const r = await run(this.bin, ['status', root, '-j'], { cwd: root, timeoutMs: this.timeoutMs });
    if (!r.ok) return this.unavailable(this.reasonFor(r));

    let parsed: CodegraphStatus;
    try {
      parsed = JSON.parse(r.stdout) as CodegraphStatus;
    } catch {
      return this.unavailable('sortie illisible');
    }
    if (!parsed.initialized) return this.unavailable('index non initialisé');

    const pc = parsed.pendingChanges;
    const pending = (pc?.added ?? 0) + (pc?.modified ?? 0) + (pc?.removed ?? 0);
    return {
      engine: 'codegraph',
      // Piège du chantier 08 : `worktreeMismatch` signale un index copié d'un autre chemin —
      // on le rend `stale` avec un motif, jamais `ready` à tort, et jamais un reindex d'office.
      state: parsed.worktreeMismatch || pending > 0 ? 'stale' : 'ready',
      ...(parsed.worktreeMismatch
        ? { reason: this.worktreeMismatchReason(parsed.worktreeMismatch) }
        : {}),
      indexedAt: parsed.lastIndexed ?? null,
      files: parsed.fileCount ?? 0,
      symbols: parsed.nodeCount ?? 0,
      languages: parsed.languages ?? [],
      pending,
      engineVersion: parsed.version ?? null,
      builtWith: parsed.index?.builtWithVersion ?? null,
      capabilities: CAPABILITIES,
    };
  }

  private worktreeMismatchReason(mismatch: unknown): string {
    const detail = typeof mismatch === 'string' ? mismatch : 'reindex conseillé';
    return `index copié depuis un autre chemin (worktreeMismatch) : ${detail}`;
  }

  async explore(
    root: string,
    query: string,
    opts: { maxFiles?: number } = {},
  ): Promise<{ text: string }> {
    const args = ['explore', query, '-p', root];
    if (opts.maxFiles) args.push('--max-files', String(opts.maxFiles));
    const r = await run(this.bin, args, { cwd: root, timeoutMs: this.timeoutMs });
    if (!r.ok) throw new StructuralUnavailable(this.reasonFor(r));
    // Pas de --json sur explore (DS6) : texte opaque, jamais parsé.
    return { text: r.stdout };
  }

  async symbols(
    root: string,
    q: string,
    opts: { kind?: string; limit?: number } = {},
  ): Promise<SymbolRef[]> {
    const args = ['query', q, '-p', root, '-j', '-l', String(opts.limit ?? 10)];
    if (opts.kind) args.push('-k', opts.kind);
    const r = await run(this.bin, args, { cwd: root, timeoutMs: this.timeoutMs });
    if (!r.ok) throw new StructuralUnavailable(this.reasonFor(r));
    const hits = this.parseJson<CodegraphQueryHit[]>(r.stdout);
    return hits.map((hit) => toSymbol(hit.node)).filter((s) => !isExcluded(s.file, this.exclude));
  }

  async callers(root: string, symbol: string, limit = 20): Promise<Relation[]> {
    const r = await run(this.bin, ['callers', symbol, '-p', root, '-j', '-l', String(limit)], {
      cwd: root,
      timeoutMs: this.timeoutMs,
    });
    if (!r.ok) throw new StructuralUnavailable(this.reasonFor(r));
    const parsed = this.parseJson<CodegraphCallers>(r.stdout);
    // codegraph ne rend que le nom du symbole visé par `callers`, jamais sa position réelle :
    // `to` reste volontairement partiel (kind/file/line inconnus) plutôt que fabriqués.
    const to: SymbolRef = { name: symbol, kind: 'unknown', file: '', line: 0 };
    return parsed.callers
      .map((c) => ({ from: toSymbol(c), to, kind: 'calls' as const, provenance: PROVENANCE }))
      .filter((rel) => !isExcluded(rel.from.file, this.exclude));
  }

  async impact(
    root: string,
    symbol: string,
    depth = 2,
  ): Promise<{ affected: SymbolRef[]; provenance: Provenance }> {
    const r = await run(this.bin, ['impact', symbol, '-p', root, '-j', '-d', String(depth)], {
      cwd: root,
      timeoutMs: this.timeoutMs,
    });
    if (!r.ok) throw new StructuralUnavailable(this.reasonFor(r));
    const parsed = this.parseJson<CodegraphImpact>(r.stdout);
    const affected = parsed.affected.map(toSymbol).filter((s) => !isExcluded(s.file, this.exclude));
    return { affected, provenance: PROVENANCE };
  }

  async affected(root: string, files: string[]): Promise<{ tests: string[] }> {
    const r = await run(this.bin, ['affected', '-p', root, '-j', '--stdin'], {
      cwd: root,
      timeoutMs: this.timeoutMs,
      input: files.join('\n'),
    });
    if (!r.ok) throw new StructuralUnavailable(this.reasonFor(r));
    const parsed = this.parseJson<CodegraphAffected>(r.stdout);
    return { tests: parsed.affectedTests.filter((f) => !isExcluded(f, this.exclude)) };
  }

  private unavailable(reason: string): IndexStatus {
    return {
      engine: 'codegraph',
      state: 'unavailable',
      reason,
      indexedAt: null,
      files: 0,
      symbols: 0,
      languages: [],
      pending: 0,
      engineVersion: null,
      builtWith: null,
      capabilities: [],
    };
  }

  private reasonFor(r: { timedOut: boolean; spawnErrorCode?: string; stderr: string }): string {
    if (r.timedOut) return `délai dépassé (${this.timeoutMs}ms)`;
    if (r.spawnErrorCode === 'ENOENT') return `binaire introuvable : ${this.bin}`;
    return r.stderr.trim() || 'codegraph a échoué';
  }

  private parseJson<T>(stdout: string): T {
    try {
      return JSON.parse(stdout) as T;
    } catch {
      throw new StructuralUnavailable('sortie illisible');
    }
  }
}
