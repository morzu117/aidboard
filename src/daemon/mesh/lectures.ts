import type { BoardResult, Parsed } from '../../shared/board.js';
import {
  parsePeers,
  parseRights,
  parseCodegraph,
  parseMemoryList,
  parseMemoryPage,
  parseMemoryLinks,
  requeteCodegraphValide,
  tagValide,
  slugValide,
} from '../../shared/swarph.js';
import { classify, type ReadOpts } from './board.js';
import type { MeshService } from './service.js';
import type { MeshExecResult } from './exec.js';

interface Lecture {
  exec: MeshExecResult;
  readAt: string;
}
interface Entree {
  at: number;
  result: Promise<Lecture>;
}

export interface SwarphReaderDeps {
  mesh: Pick<MeshService, 'read' | 'current'>;
  cell: string;
  gateway?: string;
  log: (ligne: string) => void;
  now?: () => number;
}

/** Six lectures fermées, cache de 5 s et fusion des demandes en cours (D239). */
export class SwarphReader {
  private readonly cache = new Map<string, Entree>();
  constructor(private readonly deps: SwarphReaderDeps) {}

  monitor() {
    return this.deps.mesh.current();
  }

  peers(opts: ReadOpts = {}) {
    return this.load(['mesh', 'peers', '--as', this.deps.cell], parsePeers, opts);
  }

  rights(opts: ReadOpts = {}) {
    return this.load(['rights', '--json', '--as', this.deps.cell], parseRights, opts);
  }

  async codegraph(requete: string, opts: ReadOpts = {}) {
    this.valider(requete, requeteCodegraphValide);
    return this.load(
      [
        'codegraph',
        '--local',
        '--json',
        '--limit',
        '50',
        '--caller-cell',
        this.deps.cell,
        '--',
        requete,
      ],
      (json) => {
        const parsed = parseCodegraph(json);
        return parsed && { ...parsed, value: { lignes: parsed.value, perime: false } };
      },
      opts,
    );
  }

  async memory(tag: string, opts: ReadOpts = {}) {
    this.valider(tag, tagValide);
    return this.load(
      ['memory', 'list', '--tag', tag, '-n', '100', '--json'],
      parseMemoryList,
      opts,
    );
  }

  async page(slug: string, opts: ReadOpts = {}) {
    this.valider(slug, slugValide);
    const [page, links] = await Promise.all([
      this.load(['memory', 'get', slug, '--json'], parseMemoryPage, opts),
      this.load(['memory', 'links', slug, '--direction', 'both', '--json'], parseMemoryLinks, opts),
    ]);
    return { page, links };
  }

  private valider(valeur: string, valide: (v: unknown) => boolean) {
    if (!valide(valeur)) throw new RangeError('argument swarph invalide');
  }

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  private async load<T>(
    args: string[],
    parse: (json: unknown) => Parsed<T> | null,
    opts: ReadOpts,
  ): Promise<BoardResult<T>> {
    const memoire = args[0] === 'memory';
    if (memoire && !this.deps.gateway) {
      return { ok: false, kind: 'not-configured', readAt: new Date(this.now()).toISOString() };
    }
    const { exec, readAt } = await this.exec(args, opts.fresh === true);
    if (
      args[0] === 'codegraph' &&
      exec.exitCode !== undefined &&
      exec.exitCode !== 0 &&
      exec.stderr.includes('NO INDEX AVAILABLE')
    ) {
      return { ok: false, kind: 'no-index', readAt };
    }
    const kind = classify(exec);
    if (kind !== null) {
      this.deps.log(`swarph : ${args[0]} : ${kind} : ${exec.stderr.trim()}`);
      return { ok: false, kind, readAt };
    }
    let valeur: Parsed<T> | null;
    try {
      valeur = parse(args[0] === 'mesh' ? exec.stdout : JSON.parse(exec.stdout));
    } catch {
      valeur = null;
    }
    if (valeur === null) return { ok: false, kind: 'format', readAt };
    if (args[0] === 'codegraph' && exec.stderr.includes('STALE INDEX')) {
      valeur.value = { ...valeur.value, perime: true };
    }
    return { ok: true, data: valeur.value, readAt, schemaVersion: valeur.schemaVersion };
  }

  private exec(args: string[], fresh: boolean): Promise<Lecture> {
    const key = args.join('\0');
    const at = this.now();
    const hit = this.cache.get(key);
    if (hit && (hit.at === -1 || (!fresh && at - hit.at < 5000))) return hit.result;
    for (const [k, e] of this.cache) if (e.at !== -1 && at - e.at >= 5000) this.cache.delete(k);
    const entree = { at: -1 } as Entree;
    const options: { env: Record<string, string>; unset?: string[] } =
      args[0] === 'memory'
        ? {
            env: { SWARPH_BRAIN_GATEWAY: this.deps.gateway!, SWARPH_SELF: this.deps.cell },
            unset: ['GBRAIN_TOKEN', 'SWARPH_BRAIN_TOKEN'],
          }
        : { env: { SWARPH_SELF: this.deps.cell } };
    entree.result = this.deps.mesh
      .read(args, options)
      .catch((err: unknown): MeshExecResult => ({
        ok: false,
        timedOut: false,
        stdout: '',
        stderr: (err as Error).message,
      }))
      .then((exec) => {
        entree.at = this.now();
        return { exec, readAt: new Date(entree.at).toISOString() };
      });
    this.cache.set(key, entree);
    return entree.result;
  }
}
