import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { mapHook, runHook, toolLabel } from '../src/cli/commands/hook.js';
import { sanitizePending } from '../src/daemon/events/status.js';
import {
  HOOK_EVENTS,
  hookCommand,
  hooksStatus,
  installHooks,
  uninstallHooks,
} from '../src/daemon/hooks/claudeSettings.js';
import { hookEnv } from '../src/daemon/pty/spawn.js';
import { issueRunToken } from '../src/daemon/security.js';
import { seedTopic, startTestDaemon, type TestDaemon } from './helpers/daemon.js';

const FIX = join(import.meta.dirname, 'fixtures/hooks');
const fixture = (name: string) =>
  JSON.parse(readFileSync(join(FIX, `${name}.json`), 'utf8')) as Record<string, unknown>;
const ROOT = join(import.meta.dirname, '..');
const SCRIPT = join(ROOT, 'scripts/hooks/aid-hook.sh');
const CLI = join(ROOT, 'dist/cli/aid.js');
const tmp = () => mkdtempSync(join(tmpdir(), 'aid-hk-'));

let t: TestDaemon | undefined;
afterEach(async () => {
  await t?.d.stop();
  t = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('table des événements (plan 06, E2)', () => {
  test('PermissionRequest : demande de permission, « Toujours » tiré de la règle proposée', () => {
    const [e] = mapHook('PermissionRequest', fixture('PermissionRequest'));
    expect(e).toEqual({
      type: 'agent.status',
      data: {
        status: 'needs_input',
        reason: 'permission',
        message: 'autoriser Bash(npm test -- pty) ?',
        pending: {
          id: 'toolu_01',
          kind: 'permission',
          question: 'autoriser Bash(npm test -- pty) ?',
          options: [
            { label: 'Autoriser une fois', answer: 'yes' },
            { label: 'Toujours pour npm test', answer: 'always' },
            { label: 'Refuser', answer: 'no' },
          ],
        },
      },
    });
    // ce que le hook envoie passe l'assainissement du daemon sans rien perdre
    expect(sanitizePending((e!.data as { pending: unknown }).pending)).toEqual(
      (e!.data as { pending: unknown }).pending,
    );
  });

  test('PermissionRequest sans règle proposée : pas de « Toujours »', () => {
    const p = { ...fixture('PermissionRequest'), permission_suggestions: [] };
    const options = (mapHook('PermissionRequest', p)[0]!.data.pending as { options: unknown[] })
      .options;
    expect(options).toEqual([
      { label: 'Autoriser une fois', answer: 'yes' },
      { label: 'Refuser', answer: 'no' },
    ]);
  });

  test('AskUserQuestion : une question à choix unique donne ses options numérotées', () => {
    const [e] = mapHook('PreToolUse', fixture('PreToolUse-AskUserQuestion'));
    expect(e!.data).toMatchObject({
      status: 'needs_input',
      reason: 'question',
      pending: {
        id: 'toolu_02',
        kind: 'question',
        question: 'Quel séparateur par défaut pour le CSV ?',
        options: [
          { label: 'Point-virgule (Excel FR)', answer: '1' },
          { label: 'Virgule', answer: '2' },
          { label: 'Rendre configurable', answer: '3' },
        ],
      },
    });
  });

  test('AskUserQuestion à choix multiples ou à plusieurs questions : pas de boutons', () => {
    const p = fixture('PreToolUse-AskUserQuestion');
    const input = p.tool_input as { questions: Array<Record<string, unknown>> };
    const multi = {
      ...p,
      tool_input: { questions: [{ ...input.questions[0], multiSelect: true }] },
    };
    expect((mapHook('PreToolUse', multi)[0]!.data.pending as { options: [] }).options).toEqual([]);
    const deux = { ...p, tool_input: { questions: [input.questions[0], input.questions[0]] } };
    expect((mapHook('PreToolUse', deux)[0]!.data.pending as { options: [] }).options).toEqual([]);
  });

  test('PreToolUse ordinaire : l’outil, puis « en cours »', () => {
    expect(mapHook('PreToolUse', fixture('PreToolUse-Write'))).toEqual([
      { type: 'agent.tool', data: { label: 'Write(src/pty/ring-buffer.ts)' } },
      { type: 'agent.status', data: { status: 'working' } },
    ]);
  });

  test('Stop : à relire, avec la première ligne du dernier message', () => {
    expect(mapHook('Stop', fixture('Stop'))).toEqual([
      {
        type: 'agent.status',
        data: { status: 'idle', message: "Tour terminé. J'ajoute les tests du tri ?" },
      },
    ]);
  });

  test('UserPromptSubmit et PostToolUse : en cours ; permission_prompt et inconnus : rien', () => {
    expect(mapHook('UserPromptSubmit', {})).toEqual([
      { type: 'agent.status', data: { status: 'working' } },
    ]);
    expect(mapHook('PostToolUse', {})).toEqual([
      { type: 'agent.status', data: { status: 'working' } },
    ]);
    expect(mapHook('Notification', fixture('Notification-permission'))).toEqual([]);
    expect(mapHook('SessionEnd', { reason: 'clear' })).toEqual([]);
    expect(mapHook('Nimporte', {})).toEqual([]);
  });

  test('libellé d’outil borné, une seule ligne', () => {
    expect(toolLabel('Bash', { command: `echo ${'x'.repeat(300)}\nrm -rf /` })).toHaveLength(
      'Bash()'.length + 120,
    );
    expect(toolLabel('Grep', { pattern: 'TODO' })).toBe('Grep(TODO)');
    expect(toolLabel('Mystère', { a: 1 })).toBe('Mystère');
  });
});

describe('aid hook', () => {
  test('hors A-I-D : code 0, rien n’est lu ni envoyé', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(await runHook('Stop', {})).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('daemon absent : code 0, rien d’affiché, l’événement attend au spool', async () => {
    const log = vi.spyOn(console, 'log');
    const err = vi.spyOn(console, 'error');
    const spool = join(tmp(), 'spool');
    const env = {
      AID_URL: 'http://127.0.0.1:9',
      AID_TOKEN: 'x',
      AID_RUN: 'run_1',
      AID_AGENT: 'ag_1',
      AID_SPOOL: spool,
    };
    expect(await runHook('UserPromptSubmit', env)).toBe(0);
    expect(log).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
    expect(readdirSync(spool)).toHaveLength(1);
  });

  test('la commande installée ne fait rien hors A-I-D, même si AID_HOOK traîne', () => {
    const clean = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.startsWith('AID_')),
    );
    for (const env of [clean, { ...clean, AID_HOOK: SCRIPT }]) {
      const out = execFileSync('sh', ['-c', hookCommand('Stop')], {
        env,
        input: '{}',
        encoding: 'utf8',
      });
      expect(out).toBe('');
    }
  });

  test.skipIf(!existsSync(CLI))(
    'chaîne complète : script livré → CLI → daemon, silencieuse et en 0',
    async () => {
      t = await startTestDaemon();
      seedTopic(t.db);
      const env = {
        PATH: process.env.PATH,
        AID_URL: `http://127.0.0.1:${t.d.port}`,
        AID_TOKEN: issueRunToken(t.d.auth, 'run_1'),
        AID_RUN: 'run_1',
        AID_AGENT: 'ag_1',
        AID_SPOOL: join(tmp(), 'spool'),
        AID_HOOK: SCRIPT,
        AID_NODE: process.execPath,
        AID_CLI: CLI,
      };
      const r = await new Promise<{ code: number; out: string }>((resolve) => {
        const child = execFile(
          'sh',
          ['-c', hookCommand('PermissionRequest')],
          { env, timeout: 20_000 },
          (e, stdout, stderr) =>
            resolve({ code: e ? ((e as { code?: number }).code ?? 1) : 0, out: stdout + stderr }),
        );
        child.stdin!.end(readFileSync(join(FIX, 'PermissionRequest.json')));
      });
      expect(r).toEqual({ code: 0, out: '' });
      const row = t.db
        .prepare('SELECT status, status_reason, pending FROM agents WHERE id = ?')
        .get('ag_1') as { status: string; status_reason: string; pending: string };
      expect(row.status).toBe('needs_input');
      expect(row.status_reason).toBe('permission');
      expect(JSON.parse(row.pending).id).toBe('toolu_01');
      const ev = t.store.since(null).find((e) => e.type === 'agent.status');
      // la lignée du hook part avec l'événement (sous-sessions, E3)
      expect(Array.isArray(ev?.data.chain)).toBe(true);
    },
    30_000,
  );
});

describe('configuration de Claude Code (E10)', () => {
  const file = () => join(tmp(), 'settings.json');

  test('fichier absent : créé avec un groupe par événement ; deuxième installation sans effet', () => {
    const path = file();
    expect(installHooks(path)).toMatchObject({ changed: true, backup: undefined });
    const s = JSON.parse(readFileSync(path, 'utf8'));
    expect(Object.keys(s.hooks).sort()).toEqual([...HOOK_EVENTS].sort());
    expect(s.hooks.PreToolUse[0]).toEqual({
      matcher: '*',
      hooks: [{ type: 'command', command: hookCommand('PreToolUse'), timeout: 5 }],
    });
    expect(s.hooks.Stop[0].matcher).toBeUndefined();
    expect(s.hooks.Notification[0].matcher).toBe('elicitation_dialog');
    expect(hooksStatus(path)).toEqual({ path, installed: true, missing: [] });
    expect(installHooks(path)).toEqual({ changed: false });
  });

  test('fichier existant : le reste est intact, une sauvegarde est faite, le retrait est exact', () => {
    const path = file();
    const original = {
      model: 'opus',
      permissions: { allow: ['Bash(ls)'] },
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'mon-hook.sh' }] }],
        SessionStart: [{ hooks: [{ type: 'command', command: 'bonjour' }] }],
      },
    };
    const raw = `${JSON.stringify(original, null, 2)}\n`;
    writeFileSync(path, raw);
    const r = installHooks(path, new Date('2026-10-16T12:00:00Z'));
    expect(r.changed && r.backup).toBe(`${path}.aid-2026-10-16T12-00-00-000Z.bak`);
    expect(readFileSync(r.changed ? r.backup! : '', 'utf8')).toBe(raw);
    const s = JSON.parse(readFileSync(path, 'utf8'));
    expect(s.model).toBe('opus');
    expect(s.permissions).toEqual(original.permissions);
    expect(s.hooks.SessionStart).toEqual(original.hooks.SessionStart);
    expect(s.hooks.PreToolUse[0]).toEqual(original.hooks.PreToolUse[0]);
    expect(s.hooks.PreToolUse).toHaveLength(2);

    uninstallHooks(path);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(original);
  });

  test('une ancienne commande A-I-D est remplacée, jamais doublée', () => {
    const path = file();
    writeFileSync(
      path,
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'aid hook Stop # AID_HOOK v0' }] }] },
      }),
    );
    expect(hooksStatus(path).missing).toContain('Stop');
    installHooks(path);
    const s = JSON.parse(readFileSync(path, 'utf8'));
    expect(s.hooks.Stop).toEqual([
      { hooks: [{ type: 'command', command: hookCommand('Stop'), timeout: 5 }] },
    ]);
  });

  test('un fichier illisible n’est jamais réécrit', () => {
    const path = file();
    writeFileSync(path, '{ "model": "opus", ');
    expect(() => installHooks(path)).toThrow(/pas du JSON valide/);
    expect(readFileSync(path, 'utf8')).toBe('{ "model": "opus", ');
    expect(hooksStatus(path).installed).toBe(false);
  });
});

describe('daemon', () => {
  test('les PTY reçoivent le script et la CLI ; sans CLI construite, pas de hooks', () => {
    expect(hookEnv((name, marker) => `/pkg/${name}#${marker}`)).toEqual({
      AID_HOOK: '/pkg/scripts/hooks#aid-hook.sh/aid-hook.sh',
      AID_NODE: process.execPath,
      AID_CLI: '/pkg/dist/cli#aid.js/aid.js',
    });
    expect(
      hookEnv(() => {
        throw new Error('introuvable');
      }),
    ).toEqual({});
  });

  test('routes : état, installation sur confirmation seulement, jamais par un agent', async () => {
    const dir = tmp();
    vi.stubEnv('CLAUDE_CONFIG_DIR', dir);
    t = await startTestDaemon();
    seedTopic(t.db);
    const inject = (method: 'GET' | 'POST', url: string, payload?: unknown, h = t!.headers) =>
      t!.d.app.inject({ method, url, headers: h, payload: payload as never });
    expect((await inject('GET', '/api/hooks')).json()).toMatchObject({
      path: join(dir, 'settings.json'),
      installed: false,
    });
    expect((await inject('POST', '/api/hooks/install', {})).statusCode).toBe(400);
    const agent = {
      host: t.headers.host!,
      authorization: `Bearer ${issueRunToken(t.d.auth, 'run_1')}`,
    };
    expect((await inject('POST', '/api/hooks/install', { confirm: true }, agent)).statusCode).toBe(
      403,
    );
    expect(existsSync(join(dir, 'settings.json'))).toBe(false);
    const ok = await inject('POST', '/api/hooks/install', { confirm: true });
    expect(ok.json()).toMatchObject({ installed: true, changed: true });
  });
});
