import type { ChildProcess } from 'node:child_process';
import type {
  IndexEngine,
  IndexStatus,
  Provenance,
  Relation,
  SymbolRef,
} from '../../shared/structural.js';
import { StructuralUnavailable } from '../../shared/structural.js';
import { CodegraphIndex } from './codegraph.js';
import type { StructuralIndex } from './types.js';

export interface StructuralServiceOpts {
  engine: IndexEngine;
  bin?: string;
  timeoutMs?: number;
  exclude?: string[];
}

// DS7 : comme gitLiveInfo pour git, l'état n'est jamais stocké — juste mis en cache 30 s par
// chemin pour épargner un sous-processus à chaque GET /api/state.
const STATUS_CACHE_MS = 30_000;

const OFF_STATUS: IndexStatus = {
  engine: 'off',
  state: 'unavailable',
  reason: 'index désactivé (structural.engine = off)',
  indexedAt: null,
  files: 0,
  symbols: 0,
  languages: [],
  pending: 0,
  engineVersion: null,
  builtWith: null,
  capabilities: [],
};

// DS1 : seul point d'entrée du daemon vers un adaptateur — routes, outils MCP et board ne
// connaissent que ce service, jamais CodegraphIndex (ni un futur Kivgraph) directement.
export class StructuralService {
  readonly engine: IndexEngine;
  private readonly impl: StructuralIndex | null;
  private readonly binPath: string | null;
  private readonly statusCache = new Map<string, { at: number; status: IndexStatus }>();

  constructor(opts: StructuralServiceOpts) {
    this.engine = opts.engine;
    if (opts.engine === 'off') {
      this.impl = null;
      this.binPath = null;
    } else {
      this.binPath = opts.bin ?? 'codegraph';
      this.impl = new CodegraphIndex(this.binPath, opts.timeoutMs, opts.exclude);
    }
  }

  /** chemin du binaire du moteur courant — pour AID_CODEGRAPH_BIN (scripts), pas pour contourner le contrat */
  get bin(): string | null {
    return this.binPath;
  }

  detect(root: string): boolean {
    return this.impl?.detect(root) ?? false;
  }

  init(root: string, log: number): ChildProcess {
    if (!this.impl) {
      throw new Error(
        'structural.init appelé avec engine = off : ne doit jamais arriver (detect aurait dû le filtrer)',
      );
    }
    return this.impl.init(root, log);
  }

  sync(root: string, log: number): ChildProcess {
    if (!this.impl) {
      throw new Error(
        'structural.sync appelé avec engine = off : ne doit jamais arriver (detect aurait dû le filtrer)',
      );
    }
    return this.impl.sync(root, log);
  }

  async status(root: string): Promise<IndexStatus> {
    if (!this.impl) return OFF_STATUS;
    const cached = this.statusCache.get(root);
    if (cached && Date.now() - cached.at < STATUS_CACHE_MS) return cached.status;
    const status = await this.impl.status(root);
    this.statusCache.set(root, { at: Date.now(), status });
    return status;
  }

  // `async` ici n'est pas cosmétique : engineOrThrow() lève de façon synchrone, et sans `async`
  // cette levée casserait l'appelant avant même qu'il obtienne une promesse à rejeter.
  async explore(
    root: string,
    query: string,
    opts?: { maxFiles?: number },
  ): Promise<{ text: string }> {
    return this.engineOrThrow().explore(root, query, opts);
  }

  async symbols(
    root: string,
    q: string,
    opts?: { kind?: string; limit?: number },
  ): Promise<SymbolRef[]> {
    return this.engineOrThrow().symbols(root, q, opts);
  }

  async callers(root: string, symbol: string, limit?: number): Promise<Relation[]> {
    return this.engineOrThrow().callers(root, symbol, limit);
  }

  async impact(
    root: string,
    symbol: string,
    depth?: number,
  ): Promise<{ affected: SymbolRef[]; provenance: Provenance }> {
    return this.engineOrThrow().impact(root, symbol, depth);
  }

  async affected(root: string, files: string[]): Promise<{ tests: string[] }> {
    return this.engineOrThrow().affected(root, files);
  }

  private engineOrThrow(): StructuralIndex {
    if (!this.impl) throw new StructuralUnavailable('index désactivé (structural.engine = off)');
    return this.impl;
  }
}
