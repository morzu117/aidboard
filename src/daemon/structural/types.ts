import type { ChildProcess } from 'node:child_process';
import type {
  IndexEngine,
  IndexStatus,
  Provenance,
  Relation,
  SymbolRef,
} from '../../shared/structural.js';

export interface StructuralIndex {
  readonly engine: IndexEngine;

  /** présence d'un index sur disque — remplace le existsSync(.codegraph) dispersé */
  detect(root: string): boolean;

  /** lance l'indexation initiale ; stdout/stderr vers `log`, l'appelant gère le cycle de vie */
  init(root: string, log: number): ChildProcess;

  status(root: string): Promise<IndexStatus>;
  explore(root: string, query: string, opts?: { maxFiles?: number }): Promise<{ text: string }>;
  symbols(root: string, q: string, opts?: { kind?: string; limit?: number }): Promise<SymbolRef[]>;
  callers(root: string, symbol: string, limit?: number): Promise<Relation[]>;
  impact(
    root: string,
    symbol: string,
    depth?: number,
  ): Promise<{ affected: SymbolRef[]; provenance: Provenance }>;
  affected(root: string, files: string[]): Promise<{ tests: string[] }>;
}
