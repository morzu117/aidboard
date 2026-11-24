import { parseArgs } from 'node:util';
import type { AidPaths } from '../../daemon/paths.js';
import { renderMarkdown } from '../../daemon/memory/store.js';
import type {
  MemoryDecision,
  MemoryLinks,
  MemoryPage,
  MemoryProposal,
  SearchResult,
} from '../../shared/memory.js';
import { callDaemon, DaemonUnreachable, resolveTarget } from '../client.js';

// Codes de sortie du contrat `aid mem` (chantier 06) : 0 ok, 1 usage ou refus simple,
// 2 conflit de révision, 3 page absente, 4 daemon injoignable, 5 interdit, 6 déjà close.
export const MEM_HELP = `aid mem : la mémoire des agents (pages markdown, recherche)

  aid mem get <slug>                                  la page sur stdout
  aid mem put <slug> [--title T] [--append | --expected-revision N | --force]
                                                      contenu sur stdin ; existante sans option = refus
  aid mem decide <slug> --title T --raison R [--remplace <slug>]… [--namespace ns] [--json]
  aid mem links <slug> [--json]
  aid mem search "<termes>" [--scope <ns>|all] [--limit N] [--closes] [--json]
  aid mem list <prefix> [--json]
  aid mem proposals [--state open|applied|rejected] [--json]
  aid mem usage [--json]                              lectures par page et dernière lecture
  aid mem rm <slug>
  aid mem purge [--dry-run] [--orphelines]              pages cycliques closes ; orphelines = liste seule
  aid mem export --dir <dir> [--scope <ns>|all]
  aid mem import --dir <dir> [--namespace <ns>]
  aid mem reindex                                     reconstruit l'index depuis ~/.aid/memory

Codes : 0 ok · 1 usage · 2 revision_conflict · 3 absente · 4 daemon injoignable · 5 interdit · 6 déjà close
`;

export interface MemIo {
  stdin: () => Promise<string>;
  stdinIsTTY?: boolean;
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

const defaultIo: MemIo = {
  stdin: readAllStdin,
  stdinIsTTY: process.stdin.isTTY,
  out: console.log,
  err: console.error,
};

function codeOf(status: number): number {
  if (status === 409) return 2;
  if (status === 404) return 3;
  if (status === 403) return 5;
  return 1;
}

function formatHits({ mode, hits, voisins }: SearchResult): string[] {
  const lines = [`mode : ${mode}`];
  for (const h of hits) {
    const via = h.via?.type === 'remplace' ? ` (remplace ${h.via.slug})` : '';
    const candidat = h.candidat ? ' (candidat)' : '';
    lines.push(`${h.score.toFixed(3)}  ${h.slug}${candidat}  ${h.title}${via}`);
    if (h.snippet) lines.push(`    ${h.snippet}`);
  }
  if (hits.length === 0) lines.push('aucun résultat');
  if (voisins?.length) {
    lines.push('Voisines :');
    for (const { slug, via, candidat } of voisins) {
      if (via) lines.push(`  ${slug}${candidat ? ' (candidat)' : ''}  ${via.type}  ${via.slug}`);
    }
  }
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
      case 'decide':
        return await decide(call, positionals[0], values, io);
      case 'links':
        return await links(call, positionals[0], values, io);
      case 'search':
        return await search(call, positionals[0], values, io);
      case 'proposals': {
        const state = values.state ?? 'open';
        if (state !== 'open' && state !== 'applied' && state !== 'rejected') {
          io.err('--state attend open, applied ou rejected');
          return 1;
        }
        const { status, json } = await call('GET', `/api/memory/proposals?state=${state}`);
        if (status !== 200) return fail(status, json, io);
        const proposals = json.proposals as MemoryProposal[];
        if (values.json) io.out(JSON.stringify(proposals));
        else {
          for (const p of proposals) {
            io.out(`${p.id.slice(-8)}  ${p.kind}  ${p.slug}  ${p.rationale.replace(/\s+/g, ' ')}`);
          }
        }
        return 0;
      }
      case 'usage': {
        const { status, json } = await call('GET', '/api/memory/usage');
        if (status !== 200) return fail(status, json, io);
        if (values.json) io.out(JSON.stringify(json));
        else {
          const pages = json.pages as Array<{ slug: string; reads: number; lastReadAt: string }>;
          for (const page of pages) io.out(`${page.reads}  ${page.lastReadAt}  ${page.slug}`);
          if (pages.length === 0) io.out('aucune lecture');
        }
        return 0;
      }
      case 'list':
        return await list(call, positionals[0] ?? '', values, io);
      case 'rm':
        return await rm(call, positionals[0], io);
      case 'purge': {
        const { status, json } = await call('POST', '/api/memory/purge', {
          dryRun: !!values['dry-run'],
          orphelines: !!values.orphelines,
        });
        if (status !== 200) return fail(status, json, io);
        // Les orphelines sont des tâches ; la purge et son aperçu listent les pages.
        const entries = (json.orphelines ? json.tasks : json.slugs) as string[];
        for (const entry of entries) io.out(entry);
        io.out(
          `${entries.length} ${json.orphelines ? 'tâche(s) orpheline(s)' : json.dryRun ? 'page(s) à purger' : 'page(s) purgée(s)'}`,
        );
        return 0;
      }
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
  'dry-run': { type: 'boolean' },
  orphelines: { type: 'boolean' },
  title: { type: 'string' },
  append: { type: 'boolean' },
  'expected-revision': { type: 'string' },
  force: { type: 'boolean' },
  state: { type: 'string' },
  scope: { type: 'string' },
  limit: { type: 'string' },
  closes: { type: 'boolean' },
  json: { type: 'boolean' },
  dir: { type: 'string' },
  namespace: { type: 'string' },
  raison: { type: 'string' },
  remplace: { type: 'string', multiple: true },
} as const;

type Values = {
  title?: string;
  append?: boolean;
  'expected-revision'?: string;
  force?: boolean;
  scope?: string;
  limit?: string;
  closes?: boolean;
  json?: boolean;
  dir?: string;
  namespace?: string;
  raison?: string;
  remplace?: string[];
};
type Call = (
  method: 'GET' | 'PUT' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
) => Promise<{ status: number; json: Record<string, unknown> }>;

function fail(status: number, json: Record<string, unknown>, io: MemIo): number {
  const error = String(json.error ?? `réponse ${status}`);
  if (status === 409 && error === 'deja_close') {
    io.err(`deja_close : ${String(json.slug)}`);
    return 6;
  }
  if (status === 409) io.err(`revision_conflict r${String(json.revision)}`);
  else if (status === 403 && json.namespace !== undefined) {
    io.err(`interdit : namespace ${String(json.namespace)} (autorisé : ${String(json.allowed)})`);
  } else if (status === 404 && json.slug) io.err(`${error} : ${String(json.slug)}`);
  else io.err(error);
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

async function decide(call: Call, slug: string | undefined, v: Values, io: MemIo): Promise<number> {
  if (!needSlug(slug, io)) return 1;
  const { title, raison, remplace, namespace } = v;
  if (!title || !raison) {
    io.err('--title et --raison sont requis');
    return 1;
  }
  const texte = io.stdinIsTTY ? '' : await io.stdin();
  const { status, json } = await call('POST', '/api/memory/decisions', {
    slug,
    title,
    raison,
    texte,
    remplace,
    namespace,
  });
  if (status !== 201) return fail(status, json, io);
  const decision = json as unknown as MemoryDecision;
  if (v.json) io.out(JSON.stringify(decision));
  else {
    io.out(
      [
        `Décision créée : ${decision.slug}`,
        ...decision.fermees.map((page) => `Page fermée : ${page}`),
      ].join('\n'),
    );
  }
  return 0;
}

async function links(call: Call, slug: string | undefined, v: Values, io: MemIo): Promise<number> {
  if (!needSlug(slug, io)) return 1;
  const { status, json } = await call('GET', `/api/memory/links/${slug}`);
  if (status !== 200) return fail(status, json, io);
  const page = json as unknown as MemoryLinks;
  if (v.json) io.out(JSON.stringify(page));
  else {
    const line = (link: MemoryLinks['sortants'][number]) =>
      `${link.type}  ${link.slug}${link.existe ? '' : ' (absente)'}`;
    io.out(
      [
        ...(page.closed ? ['close'] : []),
        'Sortants :',
        ...page.sortants.map(line),
        'Entrants :',
        ...page.entrants.map(line),
      ].join('\n'),
    );
  }
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
  if (v.closes) params.set('closes', '1');
  const { status, json } = await call('GET', `/api/memory/search?${params}`);
  if (status !== 200) return fail(status, json, io);
  if (v.json) io.out(JSON.stringify(json));
  else for (const l of formatHits(json as unknown as SearchResult)) io.out(l);
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
