import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { runMem } from '../src/cli/commands/mem.js';
import { resolvePaths } from '../src/daemon/paths.js';
import { waitFor } from './helpers/daemon.js';

const CLI = join(import.meta.dirname, '../dist/cli/aid.js');
const built = existsSync(CLI);

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as { port: number }).port;
  await new Promise((r) => s.close(r));
  return port;
}

let home = '';
interface Result {
  code: number;
  out: string;
  err: string;
}
const run = (args: string[], opts: { stdin?: string; env?: Record<string, string> } = {}) =>
  new Promise<Result>((resolve) => {
    const child = execFile(
      process.execPath,
      [CLI, ...args],
      {
        env: {
          ...process.env,
          AID_HOME: home,
          AID_NO_BROWSER: '1',
          AID_URL: '',
          AID_TOKEN: '',
          ...opts.env,
        },
        timeout: 40_000,
      },
      (err, stdout, stderr) => {
        resolve({
          code: err ? ((err as { code?: number }).code ?? 1) : 0,
          out: stdout,
          err: stderr,
        });
      },
    );
    child.stdin?.end(opts.stdin ?? '');
  });
const mem = (args: string[], stdin?: string) => run(['mem', ...args], { stdin });
const info = () =>
  JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8')) as {
    pid: number;
    port: number;
    token: string;
  };
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(!built)('aid mem en sous-processus', () => {
  beforeAll(async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'aid-cli-mem-')));
    // Même piège que test/helpers/daemon.ts : sans ce `provider: off`, le daemon réel
    // lancé ici détecte le vrai Ollama de ce poste et bascule en recherche hybride.
    writeFileSync(
      join(home, 'config.yaml'),
      `port: ${await freePort()}\nmemory:\n  embeddings:\n    provider: off\n`,
      { mode: 0o600 },
    );
    expect((await run([])).code).toBe(0);
  }, 60_000);

  afterAll(async () => {
    if (existsSync(join(home, 'daemon.json'))) {
      const { pid } = info();
      await run(['stop', '--force']);
      await waitFor(() => !alive(pid), 5000, 'arrêt').catch(() => process.kill(pid, 'SIGKILL'));
    }
  });

  test('put puis get : aller-retour, frontmatter rendu', async () => {
    const p = await mem(['put', 'aid/plan/alpha', '--title', 'Alpha'], '## Plan\n\n- point 1\n');
    expect(p.code, p.err).toBe(0);
    expect(JSON.parse(p.out)).toEqual({ slug: 'aid/plan/alpha', revision: 1 });
    const g = await mem(['get', 'aid/plan/alpha']);
    expect(g.code).toBe(0);
    expect(g.out).toBe('---\ntitle: Alpha\n---\n\n## Plan\n\n- point 1\n');
    expect(existsSync(join(home, 'memory', 'aid', 'plan', 'alpha.md'))).toBe(true);
  });

  test('put invalide : code 1 et erreur de validation du daemon', async () => {
    const r = await mem(['put', 'aid/page/a'], '---\nliens:\n  inconnu: [aid/page/b]\n---\nA');
    expect(r.code).toBe(1);
    expect(r.err.trim()).toBe('liens.inconnu : type de lien inconnu');
  });

  test('put sur une page existante sans option : code 2 et revision_conflict r1', async () => {
    const r = await mem(['put', 'aid/plan/alpha'], 'écrase ?');
    expect(r.code).toBe(2);
    expect(r.err).toContain('revision_conflict r1');
    expect((await mem(['get', 'aid/plan/alpha'])).out).toContain('point 1');
  });

  test('--append ajoute une section ; get rend les deux ; --expected-revision et --force', async () => {
    expect((await mem(['put', 'aid/plan/alpha', '--append'], '## Point 2\n\nfait')).code).toBe(0);
    const g = await mem(['get', 'aid/plan/alpha']);
    expect(g.out).toContain('- point 1\n\n## Point 2\n\nfait');
    expect((await mem(['put', 'aid/plan/alpha', '--expected-revision', '1'], 'x')).code).toBe(2);
    const ok = await mem(['put', 'aid/plan/alpha', '--expected-revision', '2'], '## Remplacé');
    expect(JSON.parse(ok.out).revision).toBe(3);
    expect((await mem(['put', 'aid/plan/alpha', '--force'], '## Forcé')).code).toBe(0);
    // --force remplace tout, frontmatter compris
    expect((await mem(['get', 'aid/plan/alpha'])).out).toBe('## Forcé\n');
    const both = await mem(['put', 'aid/plan/alpha', '--force', '--append'], 'x');
    expect(both.code).toBe(1);
    expect(both.err).toContain('exclusifs');
  });

  test('stdin vide : code 1, rien n’est écrit', async () => {
    const r = await mem(['put', 'aid/plan/vide'], '  \n');
    expect(r.code).toBe(1);
    expect(r.err).toContain('contenu vide');
    expect((await mem(['get', 'aid/plan/vide'])).code).toBe(3);
  });

  test('get absente : 3 ; slug invalide : 1 avec la règle', async () => {
    const r = await mem(['get', 'aid/plan/absente']);
    expect(r.code).toBe(3);
    expect(r.err).toContain('page absente');
    const bad = await mem(['get', 'Invalide']);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('segments');
  });

  test('search en texte et en --json ; list par préfixe', async () => {
    await mem(['put', 'lesson/sqlite/wal'], '# WAL\n\nUn seul écrivain, des lecteurs concurrents.');
    const txt = await mem(['search', 'écrivain concurrents', '--scope', 'aid']);
    expect(txt.code).toBe(0);
    expect(txt.out).toContain('mode : fts');
    expect(txt.out).toContain('lesson/sqlite/wal  WAL');
    const js = await mem(['search', 'écrivain', '--json', '--limit', '1']);
    expect(JSON.parse(js.out)).toMatchObject({
      mode: 'fts',
      hits: [{ slug: 'lesson/sqlite/wal' }],
    });
    const none = await mem(['search', 'introuvable-xyz']);
    expect(none.out).toContain('aucun résultat');
    const l = await mem(['list', 'aid/']);
    expect(l.out).toBe('aid/plan/alpha\n');
    expect(JSON.parse((await mem(['list', 'lesson/', '--json'])).out)).toEqual({
      slugs: ['lesson/sqlite/wal'],
    });
  });

  test('rm supprime ; une seconde fois : 3', async () => {
    expect((await mem(['rm', 'lesson/sqlite/wal'])).code).toBe(0);
    expect((await mem(['rm', 'lesson/sqlite/wal'])).code).toBe(3);
    expect(existsSync(join(home, 'memory', 'lesson', 'sqlite', 'wal.md'))).toBe(false);
  });

  test('export puis import par le CLI ; reindex', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aid-cli-exp-'));
    const e = await mem(['export', '--dir', dir, '--scope', 'aid']);
    expect(e.code, e.err).toBe(0);
    expect(e.out).toContain('1 page(s) exportée(s)');
    expect(existsSync(join(dir, 'aid', 'plan', 'alpha.md'))).toBe(true);
    const i = await mem(['import', '--dir', dir]);
    expect(i.code).toBe(0);
    expect(i.err).toContain('refusée, existe déjà (2) : aid/plan/alpha');
    expect(i.out).toContain('0 importée(s), 1 existante(s), 0 invalide(s)');
    const ns = await mem(['import', '--dir', join(dir, 'aid', 'plan'), '--namespace', 'copie']);
    expect(ns.out).toContain('1 importée(s)');
    expect((await mem(['get', 'copie/alpha'])).code).toBe(0);
    expect((await mem(['rm', 'copie/alpha'])).code).toBe(0);
    const r = await mem(['reindex']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('1 page(s) réindexée(s)');
    expect((await mem(['export'])).code).toBe(1);
  });

  test('AID_URL et AID_TOKEN priment sur daemon.json (agent lancé par A-I-D)', async () => {
    const { port, token } = info();
    const other = mkdtempSync(join(tmpdir(), 'aid-cli-mem-vide-'));
    const r = await run(['mem', 'list', ''], {
      env: { AID_HOME: other, AID_URL: `http://127.0.0.1:${port}`, AID_TOKEN: token },
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain('aid/plan/alpha');
    const bad = await run(['mem', 'list', ''], {
      env: { AID_HOME: other, AID_URL: `http://127.0.0.1:${port}`, AID_TOKEN: 'faux' },
    });
    expect(bad.code).toBe(1);
  });

  test('proposals : texte, JSON brut et filtre par état', async () => {
    const base = {
      kind: 'tags',
      payload: { tags: ['test'] },
      rationale: 'Justification\nsur deux lignes',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const proposals = [
      { ...base, id: 'prop_00000001', slug: 'lesson/test/ouverte', state: 'open', decidedAt: null },
      {
        ...base,
        id: 'prop_00000002',
        slug: 'lesson/test/appliquee',
        state: 'applied',
        decidedAt: base.createdAt,
      },
      {
        ...base,
        id: 'prop_00000003',
        slug: 'lesson/test/rejetee',
        state: 'rejected',
        decidedAt: base.createdAt,
      },
    ];
    const db = new Database(join(home, 'state.db'));
    try {
      const insert = db.prepare(
        'INSERT INTO memory_proposals (id, kind, slug, payload, rationale, state, created_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      );
      for (const p of proposals) {
        insert.run(
          p.id,
          p.kind,
          p.slug,
          JSON.stringify(p.payload),
          p.rationale,
          p.state,
          p.createdAt,
          p.decidedAt,
        );
      }
    } finally {
      db.close();
    }
    const texte = await mem(['proposals']);
    expect(texte.code, texte.err).toBe(0);
    expect(texte.out.trimEnd()).toBe(
      '00000001  tags  lesson/test/ouverte  Justification sur deux lignes',
    );
    for (const p of proposals) {
      const r = await mem(['proposals', '--state', p.state, '--json']);
      expect(r.code, r.err).toBe(0);
      expect(JSON.parse(r.out)).toEqual([p]);
    }
    expect(JSON.parse((await mem(['proposals', '--json'])).out)).toEqual([proposals[0]]);
    expect((await mem(['proposals', '--state', 'absent'])).code).toBe(1);
  });

  test('decide lit stdin et links affiche le graphe en texte et en JSON', async () => {
    const first = 'projet/plan/avant';
    const second = 'projet/review/avant';
    const target = 'projet/decision/choix';
    expect((await mem(['put', first], '# Avant\n\n[[projet/plan/absente]]')).code).toBe(0);
    expect((await mem(['put', second], '# Revue')).code).toBe(0);
    const args = ['--namespace', 'projet', '--title', 'Choix', '--raison', 'Motif'];
    const output = await mem(
      ['decide', 'choix', ...args, '--remplace', first, '--remplace', second],
      'Détail sur stdin\n',
    );
    expect(output.code, output.err).toBe(0);
    expect(output.out.trim().split('\n')).toEqual([
      `Décision créée : ${target}`,
      `Page fermée : ${first}`,
      `Page fermée : ${second}`,
    ]);
    const page = await mem(['get', target]);
    expect(page.out).toContain('# Choix\n\nDétail sur stdin');
    const links = await mem(['links', first]);
    expect(links.code, links.err).toBe(0);
    expect(links.out.trim().split('\n')).toEqual([
      'close',
      'Sortants :',
      'cite  projet/plan/absente (absente)',
      'Entrants :',
      `remplace  ${target}`,
    ]);
    const linksJson = await mem(['links', target, '--json']);
    expect(linksJson.code, linksJson.err).toBe(0);
    expect(JSON.parse(linksJson.out)).toEqual({
      slug: target,
      closed: false,
      sortants: [first, second].map((slug) => ({ slug, type: 'remplace', existe: true })),
      entrants: [],
    });
    const newDecision = await mem(['decide', 'suivant', ...args, '--json']);
    expect(newDecision.code, newDecision.err).toBe(0);
    expect(JSON.parse(newDecision.out)).toEqual({
      slug: 'projet/decision/suivant',
      revision: 1,
      fermees: [],
    });
    const closed = await mem(['decide', 'autre', ...args, '--remplace', first]);
    expect(closed.code).toBe(6);
    expect(closed.err).toContain(`deja_close : ${first}`);
    expect((await mem(['decide', 'choix', ...args])).code).toBe(2);
    expect((await mem(['decide', 'autre', '--title', 'Choix'])).code).toBe(1);
    expect((await mem(['links', 'projet/plan/inconnue'])).code).toBe(3);
  }, 20_000);

  test('decide sur un TTY crée la page sans attendre stdin', async () => {
    const args = [
      'decide',
      'terminal',
      '--namespace',
      'projet',
      '--title',
      'Choix',
      '--raison',
      'Motif',
    ];
    const out: string[] = [];
    const err: string[] = [];
    const code = await runMem(args, resolvePaths(home), {
      stdin: async () => {
        throw new Error('stdin ne doit pas être lu sur un TTY');
      },
      stdinIsTTY: true,
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      env: {},
    });
    expect(code, err.join('\n')).toBe(0);
    expect(out).toEqual(['Décision créée : projet/decision/terminal']);
    expect((await mem(['get', 'projet/decision/terminal'])).out).toMatch(/\n# Choix\n$/);
  });

  test('proposals sans daemon renvoie 4', async () => {
    const other = mkdtempSync(join(tmpdir(), 'aid-cli-mem-vide-'));
    expect((await run(['mem', 'proposals'], { env: { AID_HOME: other } })).code).toBe(4);
  });

  test('sans daemon : code 4 et le conseil de lancer aid ; aide : usage', async () => {
    const other = mkdtempSync(join(tmpdir(), 'aid-cli-mem-vide-'));
    const r = await run(['mem', 'get', 'aid/plan/x'], { env: { AID_HOME: other } });
    expect(r.code).toBe(4);
    expect(r.err).toContain('daemon injoignable : lancer `aid`');
    expect((await mem(['help'])).out).toContain('aid mem put');
    expect((await mem([])).code).toBe(1);
    expect((await mem(['nimporte'])).code).toBe(1);
    expect((await run(['help'])).out).toContain('aid mem');
  });
});
