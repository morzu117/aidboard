import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Tests hermétiques : ni la config git de l'utilisateur (signature, autoSetupMerge…) ni la globale du système.
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
});

export function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function commitFile(
  repo: string,
  name: string,
  content: string,
  message = `ajout ${name}`,
): void {
  writeFileSync(join(repo, name), content);
  sh(repo, 'add', name);
  sh(repo, 'commit', '-q', '-m', message);
}

export function makeOriginAndClone(
  tmp: string,
  opts: {
    base?: string;
    name?: string;
    codegraph?: boolean;
    setHead?: boolean;
    local?: boolean;
  } = {},
): { origin: string; clone: string } {
  const base = opts.base ?? 'main';
  const origin = join(tmp, 'origin.git');
  const clone = join(tmp, opts.name ?? 'mon-depot');
  mkdirSync(origin, { recursive: true });
  sh(origin, 'init', '-q', '--bare', '-b', base);
  mkdirSync(clone, { recursive: true });
  sh(clone, 'init', '-q', '-b', base);
  sh(clone, 'remote', 'add', 'origin', origin);
  commitFile(clone, 'README.md', '# dépôt de test\n', 'initial');
  sh(clone, 'push', '-q', '-u', 'origin', base);
  if (opts.setHead !== false) sh(clone, 'remote', 'set-head', 'origin', base);
  // dépôt purement local : plus de remote du tout (les refs origin/* partent avec lui)
  if (opts.local) sh(clone, 'remote', 'remove', 'origin');
  if (opts.codegraph) {
    mkdirSync(join(clone, '.codegraph'));
    writeFileSync(join(clone, '.codegraph', 'codegraph.db'), '');
  }
  return { origin, clone };
}
