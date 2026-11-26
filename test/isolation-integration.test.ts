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
  } catch (cause) {
    if (process.env.AID_BWRAP_REQUIS === '1') {
      throw new Error(`AID_BWRAP_REQUIS=1 : ${(cause as Error).message}`, { cause });
    }
    return undefined;
  }
}

const bwrap = bwrapDeTest();

it.skipIf(!bwrap)('borne les écritures et masque les identités avec le vrai bwrap', () => {
  // Le profil recouvre /tmp : le faux home doit rester sous le montage racine en lecture seule.
  const temporaire = fs.realpathSync(tmpdir());
  const parent =
    temporaire === '/tmp' || temporaire.startsWith('/tmp/') ? process.cwd() : temporaire;
  const racine = fs.realpathSync(fs.mkdtempSync(join(parent, 'aid-bwrap-')));
  try {
    const home = join(racine, 'home');
    const paths = resolvePaths(join(racine, 'aid'));
    const depot = join(racine, 'depot');
    const distant = join(racine, 'distant.git');
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
    for (const secret of [paths.config, paths.db, paths.sessionSecret]) {
      fs.writeFileSync(secret, 'factice');
    }
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
    git('git', ['init', '-q', '--bare', distant]);
    fs.mkdirSync(join(depot, '.git/hooks'), { recursive: true });
    const configGit = fs.readFileSync(join(depot, '.git/config'), 'utf8');
    fs.mkdirSync(join(worktree, '.claude'));
    fs.writeFileSync(join(worktree, '.mcp.json'), '');
    const profil = profilPour({ worktree, home, paths, agentId }, git, fs);

    const gitDir = git('git', [
      '-C',
      worktree,
      'rev-parse',
      '--path-format=absolute',
      '--git-dir',
    ]).trim();
    const argumentsBwrap = argvBwrap(profil, { pty: false }, fs);
    const verifier = (script: string, args: string[] = []) =>
      execFileSync(bwrap!, [...argumentsBwrap, '--', '/bin/sh', '-ec', script, 'sh', ...args], {
        cwd: worktree,
        env,
        timeout: 10000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    verifier(
      String.raw`
      for fichier in .git "$1/commondir" "$1/gitdir"; do
        test -f "$fichier"
        if (printf '%s' factice >> "$fichier"); then exit 1; fi
      done
    `,
      [gitDir],
    );
    verifier(
      String.raw`
      if test -d /run/user; then test -z "$(ls -A /run/user)"; fi
      if test "$1" = oui; then
        test -s /etc/resolv.conf
        getent ahostsv4 example.com >/dev/null
      fi
    `,
      [fs.existsSync('/etc/resolv.conf') ? 'oui' : 'non'],
    );

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
          git add dans-worktree || exit 5
          git -c user.name=Test -c user.email=test@example.invalid commit -qm 'Commit isolé' || exit 6
          for secret in "$AID_HOME/config.yaml" "$AID_HOME/state.db" "$AID_HOME/session.secret"; do
            if test -e "$secret"; then exit 7; fi
          done
          if git push -q "$2" HEAD:refs/heads/sujet; then exit 8; fi
          cd "$1" || exit 3
          if printf '#!/bin/sh\\n' > .git/hooks/pre-commit; then exit 4; fi
          if printf '\\n' >> .git/config; then exit 9; fi
          ls -A "$HOME/.ssh"
        `,
        'sh',
        depot,
        distant,
      ],
      { cwd: worktree, env, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    expect(fs.existsSync(join(worktree, 'dans-worktree'))).toBe(true);
    expect(fs.existsSync(join(home, 'hors-worktree'))).toBe(false);
    expect(fs.existsSync(join(depot, '.git/hooks/pre-commit'))).toBe(false);
    expect(fs.readFileSync(join(depot, '.git/config'), 'utf8')).toBe(configGit);
    expect(git('git', ['-C', worktree, 'log', '-1', '--format=%s']).trim()).toBe('Commit isolé');
    expect(git('git', ['-C', distant, 'for-each-ref'])).toBe('');
    // La même poussée réussit hors du bac à sable avec ce dépôt nu.
    git('git', ['-C', worktree, 'push', '-q', distant, 'HEAD:refs/heads/sujet']);
    expect(stdout).toBe('');
  } finally {
    fs.rmSync(racine, { recursive: true, force: true });
  }
});
