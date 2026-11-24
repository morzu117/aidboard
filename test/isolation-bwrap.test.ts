import { expect, test, vi } from 'vitest';
import { ConfigError, parseConfig } from '../src/daemon/config.js';
import { argvBwrap, gitCommunDe, type ProfilIsolation } from '../src/daemon/isolation/bwrap.js';

const profil: ProfilIsolation = {
  home: '/home/agent',
  aidHome: '/home/agent/.aid',
  worktree: '/home/agent/.aid/worktrees/sujet',
  gitCommun: '/depot/.git',
  spool: '/home/agent/.aid/spool',
  piecesJointes: '/home/agent/.aid/attachments/agent',
};

function fsSimule(dossiers: string[] = [], fichiers: string[] = []) {
  return {
    existsSync: (chemin: string) => dossiers.includes(chemin) || fichiers.includes(chemin),
    statSync: (chemin: string) => ({
      isDirectory: () => dossiers.includes(chemin),
      isFile: () => fichiers.includes(chemin),
    }),
  };
}

const base = [
  '--ro-bind',
  '/',
  '/',
  '--dev',
  '/dev',
  '--proc',
  '/proc',
  '--tmpfs',
  '/tmp',
  '--die-with-parent',
  '--unshare-pid',
];

const inscriptibles = [profil.worktree, profil.gitCommun, profil.spool, profil.piecesJointes];

test.each([true, false])('base PTY=%s et absence de montages facultatifs', (pty) => {
  expect(argvBwrap(profil, { pty }, fsSimule())).toEqual([
    ...base,
    ...(pty ? [] : ['--new-session']),
    '--tmpfs',
    profil.aidHome,
    ...inscriptibles.flatMap((chemin) => ['--bind', chemin, chemin]),
  ]);
});

test('monte les zones cachées, les exceptions inscriptibles sous AID_HOME et les recouvrements dans cet ordre', () => {
  const identites = ['.ssh', '.gnupg', '.config/gh'].map((p) => `${profil.home}/${p}`);
  const credentials = `${profil.home}/.git-credentials`;
  const etat = ['.claude', '.claude.json', '.codex', '.npm', '.cache'].map(
    (p) => `${profil.home}/${p}`,
  );
  const recouvrements = [
    '/depot/.git/config',
    '/depot/.git/hooks',
    '/depot/.git/refs/heads/main',
    '/depot/.git/packed-refs',
    '/home/agent/.claude/settings.json',
    '/home/agent/.claude/CLAUDE.md',
    '/home/agent/.claude/commands',
    '/home/agent/.claude/agents',
    '/home/agent/.claude/skills',
    '/home/agent/.claude/plugins',
    '/home/agent/.codex/config.toml',
  ];
  const fs = fsSimule(identites, [credentials, ...etat, ...recouvrements]);

  expect(argvBwrap(profil, { pty: true }, fs)).toEqual([
    ...base,
    '--tmpfs',
    profil.aidHome,
    ...identites.flatMap((chemin) => ['--tmpfs', chemin]),
    '--ro-bind',
    '/dev/null',
    credentials,
    ...[...inscriptibles, ...etat].flatMap((chemin) => ['--bind', chemin, chemin]),
    ...recouvrements.flatMap((chemin) => ['--ro-bind', chemin, chemin]),
  ]);
});

test('ignore les identités de type inattendu', () => {
  const fs = fsSimule(['/home/agent/.git-credentials'], ['/home/agent/.ssh']);
  expect(argvBwrap(profil, { pty: true }, fs)).toEqual(
    argvBwrap(profil, { pty: true }, fsSimule()),
  );
});

test.each([
  ['worktree', 'sujet'],
  ['spool', '/spool\ncache'],
  ['tmp', '/tmp\r'],
])('refuse le chemin invalide de %s', (champ, chemin) => {
  expect(() => argvBwrap({ ...profil, [champ]: chemin }, { pty: true }, fsSimule())).toThrow(champ);
});

test('demande à git le chemin absolu du répertoire commun', () => {
  const exec = vi.fn(() => '/depot avec espaces/.git\n');
  expect(gitCommunDe(profil.worktree, exec)).toBe('/depot avec espaces/.git');
  expect(exec).toHaveBeenCalledExactlyOnceWith('git', [
    '-C',
    profil.worktree,
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
});

test('signale un échec de git sans repli', () => {
  const exec = vi.fn(() => {
    throw new Error('échec de rev-parse');
  });
  expect(() => gitCommunDe(profil.worktree, exec)).toThrow(
    'Impossible de déterminer le répertoire git commun',
  );
  expect(exec).toHaveBeenCalledTimes(1);
});

test('agents.isolation vaut off par défaut et accepte bwrap', () => {
  expect(parseConfig('').agents.isolation).toBe('off');
  expect(parseConfig('agents:\n  isolation: bwrap\n').agents.isolation).toBe('bwrap');
});

test('agents.isolation invalide produit une ConfigError', () => {
  const lire = () => parseConfig('agents:\n  isolation: inconnue\n');
  expect(lire).toThrow(ConfigError);
  expect(lire).toThrow("agents.isolation vaut 'off' ou 'bwrap'");
});
