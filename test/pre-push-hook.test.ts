import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('pre-push hook', () => {
  const zero = '0'.repeat(40);
  const branch = 'refs/heads/topic';
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  let temp: string;
  let repo: string;
  let bin: string;
  let marker: string;
  let hook: string;
  let base: string;

  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, env: gitEnv, encoding: 'utf8' }).trim();

  function commit(path: string) {
    const file = join(repo, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'fixture\n');
    git('add', path);
    git('commit', '-qm', 'fixture');
    return git('rev-parse', 'HEAD');
  }

  function push(
    updates: string[],
    { fail = false, cwd = repo }: { fail?: boolean; cwd?: string } = {},
  ) {
    const result = spawnSync(hook, ['origin', 'unused'], {
      cwd,
      input: updates.join('\n') + '\n',
      encoding: 'utf8',
      env: {
        ...gitEnv,
        PATH: bin + ':' + process.env.PATH,
        MARKER: marker,
        REPO: repo,
        GATE_EXIT: fail ? '1' : '0',
      },
    });
    expect(result.error).toBeUndefined();
    return result;
  }

  function update(local: string, remote = base, ref = branch) {
    return `${branch} ${local} ${ref} ${remote}`;
  }

  beforeEach(() => {
    temp = mkdtempSync(join(tmpdir(), 'aid-pre-push-'));
    repo = join(temp, 'repo');
    bin = join(temp, 'bin');
    marker = join(temp, 'gate.log');
    hook = join(repo, 'pre-push');
    mkdirSync(repo);
    mkdirSync(bin);
    git('init', '-q', '-b', 'main', '--object-format=sha1');
    git('init', '-q', '--bare', join(temp, 'origin.git'));
    git('config', '--local', 'user.name', 'Fixture');
    git('config', '--local', 'user.email', 'fixture@example.invalid');
    git('remote', 'add', 'origin', join(temp, 'origin.git'));
    base = commit('base.txt');
    git('push', '-q', 'origin', 'main');
    git('switch', '-qc', 'topic');
    copyFileSync(join(import.meta.dirname, '../.githooks/pre-push'), hook);
    writeFileSync(marker, '');
    writeFileSync(
      join(bin, 'npm'),
      [
        '#!/bin/sh',
        '[ "$PWD" = "$REPO" ] || exit 2',
        'if read -r unexpected; then exit 2; fi',
        'echo "$*" >> "$MARKER"',
        'exit "$GATE_EXIT"',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
  });

  afterEach(() => rmSync(temp, { recursive: true, force: true }));

  it('runs the gate once from the repository root for a code change', () => {
    const sha = commit('src/code.ts');
    const result = push([update(sha)], { cwd: join(repo, 'src') });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('gate vert');
    expect(readFileSync(marker, 'utf8')).toBe('run gate\n');
  });

  it('skips documentation-only changes', () => {
    commit('docs/x.md');
    commit('docs/fixture.txt');
    const result = push([update(commit('notes/fixture.md'))]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('gate ignoré');
    expect(readFileSync(marker, 'utf8')).toBe('');
  });

  it('skips a push to main', () => {
    expect(push([update(commit('code.ts'), base, 'refs/heads/main')]).status).toBe(0);
    expect(readFileSync(marker, 'utf8')).toBe('');
  });

  it('skips a branch deletion', () => {
    expect(push([`(delete) ${zero} ${branch} ${base}`]).status).toBe(0);
    expect(readFileSync(marker, 'utf8')).toBe('');
  });

  it('rejects the push when the gate fails', () => {
    const result = push([update(commit('code.ts'))], { fail: true });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'pre-push : gate rouge, poussée refusée (git push --no-verify pour passer outre)',
    );
    expect(readFileSync(marker, 'utf8')).toBe('run gate\n');
  });

  it('runs the gate for code on a new branch', () => {
    expect(push([update(commit('docs/x.md'), zero)]).status).toBe(0);
    expect(readFileSync(marker, 'utf8')).toBe('');
    expect(push([update(commit('code.ts'), zero)]).status).toBe(0);
    expect(readFileSync(marker, 'utf8')).toBe('run gate\n');
  });

  it('runs the gate once for two refs with code changes', () => {
    const first = commit('first.ts');
    const second = commit('second.ts');
    const result = push([update(first), update(second, first, 'refs/heads/other')]);
    expect(result.status).toBe(0);
    expect(readFileSync(marker, 'utf8')).toBe('run gate\n');
  });
});
