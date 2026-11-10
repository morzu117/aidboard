import {
  creerLecteurCli,
  creerLecteurProxy,
  type Lecteur,
  type ResultatLecture,
} from './lecteur.js';
import {
  type BoardCard,
  type BoardCardSheet,
  type BoardCardSummary,
  type BoardErrorKind,
  type BoardGraph,
  type BoardObligations,
  type BoardProject,
  type BoardResult,
  type BoardThread,
  type Parsed,
  parseCard,
  parseCards,
  parseGraph,
  parseObligations,
  parseProjects,
  parseThread,
} from '../../shared/board.js';
import { parseRechercheCartes, type RechercheCartes } from '../../shared/swairm-board.js';
import type { MeshExecResult } from './exec.js';

/** Sans `--limit`, le gateway rend les 200 messages les plus anciens, sans dire que le fil est tronqué. */
export const THREAD_LIMIT = 1000;
const CACHE_MS = 5000;

export interface BoardReaderDeps {
  mesh: { read(args: string[]): Promise<MeshExecResult> };
  cell: string;
  proxySocket?: string;
  log: (line: string) => void;
  now?: () => number;
  cacheMs?: number;
}

export interface ReadOpts {
  /** contourne le cache (bouton Relire) */
  fresh?: boolean;
  sansCache?: boolean;
}

/** Un numéro de projet ou de carte : un entier positif, rien d'autre ne va jusqu'à swarph (D93). */
export const isBoardId = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

// Les textes de stderr ne sont pas un contrat stable : ils servent à classer, jamais à afficher (D95).
// Ce qui ne correspond à rien de connu est `unknown`, jamais `unreachable`.
export function classify(r: MeshExecResult): BoardErrorKind | null {
  if (r.ok) return null;
  if (r.spawnErrorCode === 'ENOENT' || r.spawnErrorCode === 'EACCES') return 'absent';
  if (r.spawnErrorCode === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'too-large';
  if (r.timedOut) return 'timeout';
  if (r.exitCode === 2) return 'too-old';
  const err = r.stderr;
  if (err.includes('no read grant') || err.includes('gateway 403')) return 'forbidden';
  if (err.includes('gateway unreachable')) return 'unreachable';
  if (err.includes('cannot resolve a mesh credential')) return 'credential';
  // D95 bis : « card N not found », et un jeton révoqué ; « Relire » n'aboutirait ni à l'un ni à l'autre
  if (err.includes('gateway 404')) return 'not-found';
  if (err.includes('gateway 401')) return 'credential';
  return 'unknown';
}

interface Entry {
  at: number;
  result: Promise<Read>;
}

interface Read {
  exec: ResultatLecture;
  readAt: string;
}

/**
 * Lectures du board pour l'interface (chantier 24). Une liste fermée de six commandes, toujours
 * `--json --as <cell>` (D93) ; rien n'est stocké en base, un cache mémoire de 5 s par commande, et deux
 * demandes identiques simultanées ne lancent qu'un swarph (D94).
 */
export class BoardReader {
  private readonly cache = new Map<string, Entry>();

  private readonly lecteur: Lecteur;
  constructor(private readonly deps: BoardReaderDeps) {
    this.lecteur = deps.proxySocket
      ? creerLecteurProxy(deps.proxySocket)
      : creerLecteurCli(deps.mesh);
  }

  projects(opts: ReadOpts = {}): Promise<BoardResult<BoardProject[]>> {
    return this.load(['board', 'projects', 'list'], parseProjects, opts);
  }

  async cards(projectId: number, opts: ReadOpts = {}): Promise<BoardResult<BoardCardSummary[]>> {
    const id = this.id(projectId);
    return this.load(['board', 'cards', 'list', '--project', id], parseCards, opts);
  }

  chercherCartes(q: string): Promise<BoardResult<RechercheCartes>> {
    if (q.length > 1000) throw new RangeError('board : recherche trop longue');
    return this.load(['board', 'cards', 'list', '--search', q], parseRechercheCartes, {});
  }

  /** La fiche : `show`, `graph`, `thread` et `obligations` en parallèle, chacun avec son propre résultat. */
  async card(cardId: number, opts: ReadOpts = {}): Promise<BoardCardSheet> {
    const id = this.id(cardId);
    const [card, graph, thread, obligations] = await Promise.all([
      this.load<BoardCard>(['board', 'cards', 'show', id], parseCard, opts),
      this.load<BoardGraph>(['board', 'cards', 'graph', id], parseGraph, opts),
      this.load<BoardThread>(
        ['board', 'cards', 'thread', id, '--limit', String(THREAD_LIMIT)],
        (json) => parseThread(json, THREAD_LIMIT),
        opts,
      ),
      this.load<BoardObligations>(
        ['board', 'obligations', 'list', '--card', id],
        parseObligations,
        opts,
      ),
    ]);
    return { card, graph, thread, obligations };
  }

  /** Lecture seule pour l’aperçu, sans conserver le rappel en cache. */
  obligations(cardId: number): Promise<BoardResult<BoardObligations>> {
    return this.load(
      ['board', 'obligations', 'list', '--card', this.id(cardId)],
      parseObligations,
      { sansCache: true },
    );
  }

  private id(v: number): string {
    if (!isBoardId(v)) throw new RangeError(`board : identifiant invalide : ${String(v)}`);
    return String(v);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private async load<T>(
    verb: string[],
    parse: (json: unknown) => Parsed<T> | null,
    opts: ReadOpts,
  ): Promise<BoardResult<T>> {
    const args = [...verb, '--json', '--as', this.deps.cell];
    const { exec, readAt } = await this.exec(args, opts.fresh === true, opts.sansCache === true);
    const kind = exec.kind ?? classify(exec);
    if (kind !== null) {
      this.deps.log(
        `board : ${verb.join(' ')} : ${kind}${exec.spawnErrorCode ? ` (${exec.spawnErrorCode})` : ''} : ${exec.stderr.trim()}`,
      );
      return { ok: false, kind, readAt };
    }
    let json: unknown;
    try {
      json = JSON.parse(exec.stdout) as unknown;
    } catch {
      this.deps.log(`board : ${verb.join(' ')} : sortie JSON illisible`);
      return { ok: false, kind: 'format', readAt };
    }
    const value = parse(json);
    if (value === null) {
      this.deps.log(`board : ${verb.join(' ')} : forme JSON inattendue`);
      return { ok: false, kind: 'format', readAt };
    }
    return { ok: true, data: value.value, readAt, schemaVersion: value.schemaVersion };
  }

  private exec(args: string[], fresh: boolean, sansCache = false): Promise<Read> {
    const key = args.join('\0');
    const at = this.now();
    const ttl = this.deps.cacheMs ?? CACHE_MS;
    // une lecture en cours (at === -1) est toujours rejointe, même pour `fresh` : elle est déjà fraîche
    const hit = this.cache.get(key);
    if (!sansCache && hit && (hit.at === -1 || (!fresh && at - hit.at < ttl))) return hit.result;
    for (const [k, e] of this.cache) if (e.at !== -1 && at - e.at >= ttl) this.cache.delete(k);
    const entry = { at: -1 } as Entry;
    entry.result = this.lecteur.lire(args).then(
      (exec) => {
        entry.at = this.now();
        return { exec, readAt: new Date(entry.at).toISOString() };
      },
      (err: unknown) => {
        entry.at = this.now();
        const exec: MeshExecResult = {
          ok: false,
          timedOut: false,
          stdout: '',
          stderr: (err as Error).message,
        };
        return { exec, readAt: new Date(entry.at).toISOString() };
      },
    );
    if (!sansCache) this.cache.set(key, entry);
    return entry.result;
  }
}
