import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AidHttpError } from '../src/daemon/errors.js';
import type { StateSnapshot } from '../src/shared/state.js';
import { seedTopic, startTestDaemon, waitFor } from './helpers/daemon.js';

describe.each(['pty', 'stream'] as const)('lancement local %s', (transport) => {
  it.each([
    { isolation: 'off', kind: 'claude', isole: undefined },
    { isolation: 'bwrap', kind: 'claude', isole: true, preexistant: false },
    { isolation: 'bwrap', kind: 'claude', isole: true, preexistant: true },
    { isolation: 'bwrap', kind: 'shell', isole: undefined },
    { isolation: 'bwrap', kind: 'claude', isole: undefined, gitInvalide: true },
  ] as const)('$kind $isolation, existants=$preexistant', async (cas) => {
    const racine = realpathSync(mkdtempSync(join(tmpdir(), 'aid-isolation-')));
    const home = join(racine, 'home');
    const worktree = join(racine, 'sujet');
    const aidHome = join(racine, 'aid');
    const argv = join(racine, 'argv');
    const temoin = join(racine, 'temoin');
    const bwrap = join(racine, 'bwrap');
    let t: Awaited<ReturnType<typeof startTestDaemon>> | undefined;
    try {
      mkdirSync(home);
      writeFileSync(join(home, '.claude.json'), '{}');
      vi.stubEnv('HOME', home);
      vi.stubEnv('AID_HOME', aidHome);
      mkdirSync(worktree);
      const claudeProjet = join(worktree, '.claude');
      const mcpProjet = join(worktree, '.mcp.json');
      const preexistant = 'preexistant' in cas && cas.preexistant;
      if (preexistant) {
        mkdirSync(claudeProjet);
        writeFileSync(mcpProjet, '');
      }
      const gitInvalide = 'gitInvalide' in cas;
      if (!gitInvalide) execFileSync('git', ['init', '-q', worktree]);
      writeFileSync(
        bwrap,
        `#!/bin/sh
case "$1" in
  --version) echo 'bubblewrap test'; exit 0 ;;
esac
if [ "$#" -ne 9 ]; then
  printf '%s\\n' "$@" > "$(dirname "$0")/argv"
fi
while [ "$1" != -- ]; do shift; done
shift
exec "$@"
`,
        { mode: 0o700 },
      );
      const fauxAgent = '#!/bin/sh\nprintf "%s" "$PWD" > "$(dirname "$0")/temoin"\nexec cat\n';
      const claude = join(racine, 'claude');
      const shell = join(racine, 'shell-test');
      for (const fichier of [claude, shell]) writeFileSync(fichier, fauxAgent, { mode: 0o700 });
      vi.stubEnv('PATH', [racine, process.env.PATH].join(delimiter));
      vi.stubEnv('SHELL', shell);
      t = await startTestDaemon(aidHome, {
        config: { agents: { transport, isolation: cas.isolation } },
        sondeBwrap: { platform: 'linux' },
      });
      seedTopic(t.db);
      t.db.prepare('UPDATE workspaces SET root = ?').run(worktree);
      t.db.prepare('UPDATE topics SET worktree = ?').run(worktree);
      const spawn = () => t!.d.agents.spawn({ topicId: 'tp_1', kind: cas.kind });
      if (gitInvalide) {
        expect(spawn).toThrow(
          expect.objectContaining({
            constructor: AidHttpError,
            status: 422,
            message: expect.stringContaining('Impossible de déterminer le répertoire git commun'),
          }),
        );
        expect(existsSync(argv)).toBe(false);
        expect(existsSync(temoin)).toBe(false);
        return;
      }

      const agent = spawn();
      expect(agent.isole).toBe(cas.isole);
      const manager = t.d.agents;
      expect((manager.get(agent.id) ?? manager.getStream(agent.id))?.isole).toBe(cas.isole);
      expect(agent.command[0]).toBe(cas.kind === 'claude' ? claude : shell);
      await waitFor(() => existsSync(temoin) && readFileSync(temoin, 'utf8') === worktree);
      if (cas.isole) {
        const args = readFileSync(argv, 'utf8').trimEnd().split('\n');
        expect(args.slice(args.indexOf('--') + 1)).toEqual([
          agent.command[0],
          '--strict-mcp-config',
          ...agent.command.slice(1),
        ]);
        expect(args.includes('--new-session')).toBe(transport === 'stream');
        expect(existsSync(claudeProjet)).toBe(true);
        expect(readFileSync(mcpProjet, 'utf8')).toBe('');
      } else {
        expect(existsSync(argv)).toBe(false);
      }
      const state = await t.d.app.inject({ url: '/api/state', headers: t.headers });
      expect(state.statusCode).toBe(200);
      expect(state.json<StateSnapshot>().bwrapVersion).toBe(
        cas.isolation === 'bwrap' ? 'bubblewrap test' : 'off',
      );
      expect(state.json<StateSnapshot>().agents.find(({ id }) => id === agent.id)?.isole).toBe(
        cas.isole,
      );
      if (cas.isole) {
        await manager.stop(agent.id, 'user');
        if (!preexistant) {
          await waitFor(() => !existsSync(mcpProjet) && !existsSync(claudeProjet));
        }
        expect(existsSync(mcpProjet)).toBe(preexistant);
        expect(existsSync(claudeProjet)).toBe(preexistant);
      }
    } finally {
      await t?.d.stop();
      vi.unstubAllEnvs();
      rmSync(racine, { recursive: true, force: true });
    }
  });
});
