import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { argvBwrap } from '../src/daemon/isolation/bwrap.js';
import { profilPour } from '../src/daemon/isolation/lanceur.js';
import { sonderBwrap } from '../src/daemon/isolation/sonde.js';
import { ensureHome, resolvePaths } from '../src/daemon/paths.js';

function bwrapDeTest() {
  try {
    return sonderBwrap().bin;
  } catch {
    return undefined;
  }
}

const bwrap = bwrapDeTest();

it.skipIf(!bwrap)('borne les écritures et masque les identités avec le vrai bwrap', () => {
  // Le profil recouvre /tmp : le faux home doit rester sous le montage racine en lecture seule.
  const temporaire = fs.realpathSync(tmpdir());
  const parent = temporaire === '/tmp' || temporaire.startsWith('/tmp/') ? '/var/tmp' : temporaire;
  const racine = fs.realpathSync(fs.mkdtempSync(join(parent, 'aid-bwrap-')));
  try {
    const home = join(racine, 'home');
    const paths = resolvePaths(join(racine, 'aid'));
    const depot = join(racine, 'depot');
    const worktree = join(paths.worktrees, 'sujet');
    const agentId = 'ag_test';
    const env = {
      ...process.env,
      HOME: home,
      AID_HOME: paths.home,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    };
    const git = (bin: string, args: string[]) => execFileSync(bin, args, { encoding: 'utf8', env });
    ensureHome(paths);
    fs.mkdirSync(join(paths.attachments, agentId), { recursive: true });
    fs.mkdirSync(join(home, '.ssh'), { recursive: true });
    fs.writeFileSync(join(home, '.ssh/id_test'), 'factice');
    git('git', ['init', '-q', depot]);
    git('git', [
      '-C',
      depot,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-qm',
      'Initial',
      '--allow-empty',
    ]);
    git('git', ['-C', depot, 'worktree', 'add', '-qb', 'sujet', worktree]);
    fs.mkdirSync(join(depot, '.git/hooks'), { recursive: true });
    const profil = profilPour({ worktree, home, paths, agentId }, git, fs);

    const stdout = execFileSync(
      bwrap!,
      [
        ...argvBwrap(profil, { pty: false }, fs),
        '--',
        '/bin/sh',
        '-c',
        `
          touch dans-worktree || exit 1
          if touch "$HOME/hors-worktree"; then exit 2; fi
          cd "$1" || exit 3
          if touch .git/hooks/x; then exit 4; fi
          ls -A "$HOME/.ssh"
        `,
        'sh',
        depot,
      ],
      { cwd: worktree, env, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    expect(fs.existsSync(join(worktree, 'dans-worktree'))).toBe(true);
    expect(fs.existsSync(join(home, 'hors-worktree'))).toBe(false);
    expect(fs.existsSync(join(depot, '.git/hooks/x'))).toBe(false);
    expect(stdout).toBe('');
  } finally {
    fs.rmSync(racine, { recursive: true, force: true });
  }
});
