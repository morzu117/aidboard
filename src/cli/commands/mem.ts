import { parseArgs } from 'node:util';
import type { AidPaths } from '../../daemon/paths.js';
import { renderMarkdown } from '../../daemon/memory/store.js';
import type { MemoryPage, SearchHit, SearchMode } from '../../shared/memory.js';
import { callDaemon, DaemonUnreachable, resolveTarget } from '../client.js';

// Codes de sortie du contrat `aid mem` (chantier 06) : 0 ok, 1 usage ou refus simple,
// 2 conflit de révision, 3 page absente, 4 daemon injoignable, 5 interdit.
export const MEM_HELP = `aid mem : la mémoire des agents (pages markdown, recherche)

  aid mem get <slug>                                  la page sur stdout
  aid mem put <slug> [--title T] [--append | --expected-revision N | --force]
                                                      contenu sur stdin ; existante sans option = refus
  aid mem search "<termes>" [--scope <ns>|all] [--limit N] [--json]
  aid mem list <prefix> [--json]
  aid mem rm <slug>
  aid mem export --dir <dir> [--scope <ns>|all]
  aid mem import --dir <dir> [--namespace <ns>]
  aid mem reindex                                     reconstruit l'index depuis ~/.aid/memory

Codes : 0 ok · 1 usage · 2 revision_conflict · 3 absente · 4 daemon injoignable · 5 interdit
`;

export interface MemIo {
  stdin: () => Promise<string>;
  out: (s: string) => void;
  err: (s: string) => void;
  env?: NodeJS.ProcessEnv;
}

function readAllStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (c: Buffer) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => resolve(''));
    process.stdin.resume();
  });
}

const defaultIo: MemIo = { stdin: readAllStdin, out: console.log, err: console.error };

function codeOf(status: number): number {
  if (status === 409) return 2;
  if (status === 404) return 3;
  if (status === 403) return 5;
  return 1;
}

function formatHits(mode: SearchMode, hits: SearchHit[]): string[] {
  const lines = [`mode : ${mode}`];
  for (const h of hits) {
    lines.push(`${h.score.toFixed(3)}  ${h.slug}  ${h.title}`);
    if (h.snippet) lines.push(`    ${h.snippet}`);
  }
  if (hits.length === 0) lines.push('aucun résultat');
  return lines;
}

export async function runMem(
  argv: string[],
  paths: AidPaths,
  io: MemIo = defaultIo,
): Promise<number> {
  const [sub, ...rest] = argv;
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    io.out(MEM_HELP);
    return sub ? 0 : 1;
  }
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: rest, options: OPTIONS, allowPositionals: true });
  } catch (err) {
    io.err(`${(err as Error).message}\n\n${MEM_HELP}`);
    return 1;
  }
  const { values, positionals } = parsed;
  const target = resolveTarget(paths, io.env ?? process.env);
  const call = (method: 'GET' | 'PUT' | 'POST' | 'DELETE', path: string, body?: unknown) =>
    callDaemon(target, method, path, body);
  try {
    switch (sub) {
      case 'get':
        return await get(call, positionals[0], io);
      case 'put':
        return await put(call, positionals[0], values, io);
      case 'search':
        return await search(call, positionals[0], values, io);
      case 'list':
        return await list(call, positionals[0] ?? '', values, io);
      case 'rm':
        return await rm(call, positionals[0], io);
      case 'export':
        return await exportPages(call, values, io);
      case 'import':
        return await importPages(call, values, io);
      case 'reindex': {
        const { status, json } = await call('POST', '/api/memory/reindex');
        if (status !== 200) return fail(status, json, io);
        io.out(`${String(json.pages)} page(s) réindexée(s)`);
        return 0;
      }
      default:
        io.err(`sous-commande inconnue : ${sub}\n\n${MEM_HELP}`);
        return 1;
    }
  } catch (err) {
    if (err instanceof DaemonUnreachable) {
      io.err(err.message);
      return 4;
    }
    throw err;
  }
}

const OPTIONS = {
  title: { type: 'string' },
  append: { type: 'boolean' },
  'expected-revision': { type: 'string' },
  force: { type: 'boolean' },
  scope: { type: 'string' },
  limit: { type: 'string' },
  json: { type: 'boolean' },
  dir: { type: 'string' },
  namespace: { type: 'string' },
} as const;

type Values = {
  title?: string;
  append?: boolean;
  'expected-revision'?: string;
  force?: boolean;
  scope?: string;
  limit?: string;
  json?: boolean;
  dir?: string;
  namespace?: string;
};
type Call = (
  method: 'GET' | 'PUT' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
) => Promise<{ status: number; json: Record<string, unknown> }>;

function fail(status: number, json: Record<string, unknown>, io: MemIo): number {
  const error = String(json.error ?? `réponse ${status}`);
  if (status === 409) io.err(`revision_conflict r${String(json.revision)}`);
  else if (status === 403 && json.namespace !== undefined) {
    io.err(`interdit : namespace ${String(json.namespace)} (autorisé : ${String(json.allowed)})`);
  } else io.err(error);
  return codeOf(status);
}

function needSlug(slug: string | undefined, io: MemIo): slug is string {
  if (slug) return true;
  io.err(`slug manquant\n\n${MEM_HELP}`);
  return false;
}

async function get(call: Call, slug: string | undefined, io: MemIo): Promise<number> {
  if (!needSlug(slug, io)) return 1;
  const { status, json } = await call('GET', `/api/memory/pages/${slug}`);
  if (status !== 200) return fail(status, json, io);
  io.out(renderMarkdown(json as unknown as MemoryPage).replace(/\n$/, ''));
  return 0;
}

async function put(call: Call, slug: string | undefined, v: Values, io: MemIo): Promise<number> {
  if (!needSlug(slug, io)) return 1;
  const chosen = [v.append, v['expected-revision'] !== undefined, v.force].filter(Boolean).length;
  if (chosen > 1) {
    io.err('--append, --expected-revision et --force sont exclusifs');
    return 1;
  }
  const text = await io.stdin();
  if (text.trim() === '') {
    io.err('contenu vide : rien à écrire');
    return 1;
  }
  const body: Record<string, unknown> = { text };
  if (v.title) body.title = v.title;
  if (v.append) body.mode = 'append';
  else if (v.force) body.mode = 'force';
  else if (v['expected-revision'] !== undefined) {
    const n = Number.parseInt(v['expected-revision'], 10);
    if (!Number.isInteger(n) || n < 1) {
      io.err('--expected-revision attend un entier positif');
      return 1;
    }
    body.mode = 'replace';
    body.expectedRevision = n;
  }
  const { status, json } = await call('PUT', `/api/memory/pages/${slug}`, body);
  if (status !== 200 && status !== 201) return fail(status, json, io);
  io.out(JSON.stringify({ slug: json.slug, revision: json.revision }));
  return 0;
}

async function search(call: Call, q: string | undefined, v: Values, io: MemIo): Promise<number> {
  if (!q) {
    io.err(`termes manquants\n\n${MEM_HELP}`);
    return 1;
  }
  const params = new URLSearchParams({ q });
  if (v.scope) params.set('scope', v.scope);
  if (v.limit) params.set('limit', v.limit);
  const { status, json } = await call('GET', `/api/memory/search?${params}`);
  if (status !== 200) return fail(status, json, io);
  if (v.json) io.out(JSON.stringify(json));
  else for (const l of formatHits(json.mode as SearchMode, json.hits as SearchHit[])) io.out(l);
  return 0;
}

async function list(call: Call, prefix: string, v: Values, io: MemIo): Promise<number> {
  const params = new URLSearchParams({ prefix });
  const { status, json } = await call('GET', `/api/memory/pages?${params}`);
  if (status !== 200) return fail(status, json, io);
  if (v.json) io.out(JSON.stringify(json));
  else for (const s of json.slugs as string[]) io.out(s);
  return 0;
}

async function rm(call: Call, slug: string | undefined, io: MemIo): Promise<number> {
  if (!needSlug(slug, io)) return 1;
  const { status, json } = await call('DELETE', `/api/memory/pages/${slug}`);
  if (status !== 200) return fail(status, json, io);
  io.out(`${slug} supprimée`);
  return 0;
}

async function exportPages(call: Call, v: Values, io: MemIo): Promise<number> {
  if (!v.dir) {
    io.err('--dir est requis');
    return 1;
  }
  const { status, json } = await call('POST', '/api/memory/export', {
    dir: v.dir,
    scope: v.scope ?? 'all',
  });
  if (status !== 200) return fail(status, json, io);
  io.out(`${String(json.pages)} page(s) exportée(s) dans ${v.dir}`);
  return 0;
}

async function importPages(call: Call, v: Values, io: MemIo): Promise<number> {
  if (!v.dir) {
    io.err('--dir est requis');
    return 1;
  }
  const { status, json } = await call('POST', '/api/memory/import', {
    dir: v.dir,
    ...(v.namespace && { namespace: v.namespace }),
  });
  if (status !== 200) return fail(status, json, io);
  const skipped = json.skipped as string[];
  const failed = json.failed as string[];
  for (const s of skipped) io.err(`refusée, existe déjà (2) : ${s}`);
  for (const s of failed) io.err(`refusée, slug invalide : ${s}`);
  io.out(
    `${String(json.imported)} importée(s), ${skipped.length} existante(s), ${failed.length} invalide(s)`,
  );
  return 0;
}
