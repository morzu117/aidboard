import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { renderMarkdown } from '../../daemon/memory/store.js';
import type { AidPaths } from '../../daemon/paths.js';
import type { MemoryPage } from '../../shared/memory.js';
import { callDaemon, type ClientResponse, DaemonUnreachable, resolveTarget } from '../client.js';

export type McpCall = (
  method: 'GET' | 'PUT' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
) => Promise<ClientResponse>;

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: true };

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const ko = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

function failure(r: ClientResponse): ToolResult {
  if (r.status === 404) return ko('page absente');
  if (r.status === 409)
    return ko(`revision_conflict : la page est en révision ${String(r.json.revision)}`);
  if (r.status === 403 && r.json.namespace !== undefined) {
    return ko(
      `interdit : namespace ${String(r.json.namespace)} (autorisé : ${String(r.json.allowed)})`,
    );
  }
  return ko(String(r.json.error ?? `réponse ${r.status}`));
}

// Même texte que l'indisponibilité déclarative du daemon (503 index_unavailable) : un outil
// index_* ne distingue pas moteur coupé, binaire absent ou délai dépassé, toujours « lire le code ».
function structuralFailure(r: ClientResponse): ToolResult {
  if (r.status === 503) return ko('index indisponible : lecture directe');
  return ko(String(r.json.error ?? `réponse ${r.status}`));
}

const KERNEL_RULE =
  'Règle du kernel : plan → impact, dev → explore, review → affected. Le résultat est dérivé du code : il ne se note jamais en mémoire.';

// Le daemon résout seul le sujet d'un token de run (DS2) : rien à transmettre. Un token admin
// n'a pas de sujet courant ; à défaut le daemon répond 400, et c'est alors le premier workspace
// enregistré qui sert de racine (cas interactif : `aid mcp` lancé depuis le poste de Julien).
async function scopeParams(call: McpCall): Promise<Record<string, string>> {
  const state = await call('GET', '/api/state');
  if (state.status !== 200) return {};
  const workspaces = (state.json as { workspaces?: Array<{ id: string }> }).workspaces;
  return workspaces && workspaces.length > 0 ? { workspace: workspaces[0]!.id } : {};
}

// Aucun état ici : chaque outil est une requête HTTP au daemon. Un daemon absent rend une erreur d'outil, jamais une exception.
export function buildMcpServer(call: McpCall): McpServer {
  const server = new McpServer({ name: 'aid', version: '1' });
  const guarded = (fn: () => Promise<ToolResult>) => async (): Promise<ToolResult> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof DaemonUnreachable) return ko('daemon injoignable : lancer `aid`');
      return ko(`erreur : ${(err as Error).message}`);
    }
  };

  server.registerTool(
    'memory_get',
    {
      description:
        'Lit une page de la mémoire des agents (markdown : frontmatter YAML puis corps). Slug en segments séparés par /, ex. aid/plan/<task>.',
      inputSchema: { slug: z.string() },
    },
    ({ slug }) =>
      guarded(async () => {
        const r = await call('GET', `/api/memory/pages/${slug}`);
        if (r.status !== 200) return failure(r);
        return ok(renderMarkdown(r.json as unknown as MemoryPage));
      })(),
  );

  server.registerTool(
    'memory_put',
    {
      description:
        "Écrit une page mémoire. Règle du kernel : une page de phase se complète (mode append), elle ne se remplace pas. Sans mode, création seule : une page existante est refusée (revision_conflict). expectedRevision remplace si la révision correspond ; force remplace sans condition. Un token de run n'écrit que dans le namespace de son workspace, et dans lesson/ seulement en rétro.",
      inputSchema: {
        slug: z.string(),
        text: z.string(),
        mode: z.enum(['create', 'append', 'force']).optional(),
        expectedRevision: z.number().int().positive().optional(),
        title: z.string().optional(),
      },
    },
    ({ slug, text, mode, expectedRevision, title }) =>
      guarded(async () => {
        const body: Record<string, unknown> = { text };
        if (title) body.title = title;
        if (expectedRevision !== undefined) {
          body.mode = 'replace';
          body.expectedRevision = expectedRevision;
        } else if (mode && mode !== 'create') body.mode = mode;
        const r = await call('PUT', `/api/memory/pages/${slug}`, body);
        if (r.status !== 200 && r.status !== 201) return failure(r);
        return ok(JSON.stringify({ slug: r.json.slug, revision: r.json.revision }));
      })(),
  );

  server.registerTool(
    'memory_search',
    {
      description:
        'Cherche dans la mémoire (plein texte, plus vecteurs si disponibles). scope = un namespace (qui inclut lesson/) ou all. Rend { mode, hits: [{ slug, title, snippet, score }] }.',
      inputSchema: {
        query: z.string(),
        scope: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    ({ query, scope, limit }) =>
      guarded(async () => {
        const params = new URLSearchParams({ q: query });
        if (scope) params.set('scope', scope);
        if (limit !== undefined) params.set('limit', String(limit));
        const r = await call('GET', `/api/memory/search?${params}`);
        if (r.status !== 200) return failure(r);
        return ok(JSON.stringify(r.json));
      })(),
  );

  server.registerTool(
    'memory_list',
    {
      description: 'Liste les slugs de pages mémoire qui commencent par prefix. Rend { slugs }.',
      inputSchema: { prefix: z.string() },
    },
    ({ prefix }) =>
      guarded(async () => {
        const r = await call('GET', `/api/memory/pages?${new URLSearchParams({ prefix })}`);
        if (r.status !== 200) return failure(r);
        return ok(JSON.stringify(r.json));
      })(),
  );

  server.registerTool(
    'index_status',
    {
      description: `État de l'index structurel du sujet courant (ou du premier workspace enregistré, pour l'administrateur) : moteur, état (ready/indexing/stale/unavailable), nombre de fichiers et symboles. ${KERNEL_RULE}`,
      inputSchema: {},
    },
    () =>
      guarded(async () => {
        const params = new URLSearchParams(await scopeParams(call));
        const r = await call('GET', `/api/structural/status?${params}`);
        if (r.status !== 200) return structuralFailure(r);
        return ok(JSON.stringify(r.json));
      })(),
  );

  server.registerTool(
    'index_explore',
    {
      description: `Explore le code par le sens plutôt que par un nom exact (phase dev) : rend un texte libre, jamais du JSON. ${KERNEL_RULE}`,
      inputSchema: { query: z.string(), maxFiles: z.number().int().positive().optional() },
    },
    ({ query, maxFiles }) =>
      guarded(async () => {
        const params = new URLSearchParams({ ...(await scopeParams(call)), q: query });
        if (maxFiles !== undefined) params.set('maxFiles', String(maxFiles));
        const r = await call('GET', `/api/structural/explore?${params}`);
        if (r.status !== 200) return structuralFailure(r);
        return ok(String(r.json.text));
      })(),
  );

  server.registerTool(
    'index_symbols',
    {
      description: `Cherche des symboles par nom ou motif. Rend SymbolRef[] (name, kind, file, line). ${KERNEL_RULE}`,
      inputSchema: {
        query: z.string(),
        kind: z.string().optional(),
        limit: z.number().int().positive().optional(),
      },
    },
    ({ query, kind, limit }) =>
      guarded(async () => {
        const params = new URLSearchParams({ ...(await scopeParams(call)), q: query });
        if (kind) params.set('kind', kind);
        if (limit !== undefined) params.set('limit', String(limit));
        const r = await call('GET', `/api/structural/symbols?${params}`);
        if (r.status !== 200) return structuralFailure(r);
        return ok(JSON.stringify(r.json.symbols));
      })(),
  );

  server.registerTool(
    'index_callers',
    {
      description: `Qui appelle ce symbole : des candidats (tree-sitter, jamais une résolution de type exacte), pas des références garanties. Rend Relation[]. ${KERNEL_RULE}`,
      inputSchema: { symbol: z.string(), limit: z.number().int().positive().optional() },
    },
    ({ symbol, limit }) =>
      guarded(async () => {
        const params = new URLSearchParams({ ...(await scopeParams(call)), symbol });
        if (limit !== undefined) params.set('limit', String(limit));
        const r = await call('GET', `/api/structural/callers?${params}`);
        if (r.status !== 200) return structuralFailure(r);
        return ok(JSON.stringify(r.json.callers));
      })(),
  );

  server.registerTool(
    'index_impact',
    {
      description: `Portée d'un changement sur ce symbole, en profondeur (phase plan) : quoi d'autre serait affecté avant de modifier. Rend { affected, provenance }. ${KERNEL_RULE}`,
      inputSchema: { symbol: z.string(), depth: z.number().int().positive().optional() },
    },
    ({ symbol, depth }) =>
      guarded(async () => {
        const params = new URLSearchParams({ ...(await scopeParams(call)), symbol });
        if (depth !== undefined) params.set('depth', String(depth));
        const r = await call('GET', `/api/structural/impact?${params}`);
        if (r.status !== 200) return structuralFailure(r);
        return ok(JSON.stringify(r.json));
      })(),
  );

  server.registerTool(
    'index_affected',
    {
      description: `Tests concernés par une liste de fichiers modifiés (phase review) : quoi relancer avant de fusionner. Rend { tests }. ${KERNEL_RULE}`,
      inputSchema: { files: z.array(z.string()).min(1) },
    },
    ({ files }) =>
      guarded(async () => {
        const params = new URLSearchParams(await scopeParams(call));
        const r = await call('POST', `/api/structural/affected?${params}`, { files });
        if (r.status !== 200) return structuralFailure(r);
        return ok(JSON.stringify(r.json));
      })(),
  );

  return server;
}

// La cible est résolue à chaque appel : un daemon lancé après le serveur MCP est vu.
export async function runMcp(paths: AidPaths): Promise<void> {
  const server = buildMcpServer((method, path, body) =>
    callDaemon(resolveTarget(paths), method, path, body),
  );
  const transport = new StdioServerTransport();
  transport.onclose = () => process.exit(0);
  await server.connect(transport);
}
