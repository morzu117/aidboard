import { lstatSync, realpathSync } from 'node:fs';
import { sep } from 'node:path';
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
  '--tmpfs',
  '/run',
  '--die-with-parent',
  '--unshare-pid',
];

const claudeProjet = `${profil.worktree}/.claude`;
const mcpProjet = `${profil.worktree}/.mcp.json`;
const montagesProjet = ['--ro-bind', claudeProjet, claudeProjet, '--ro-bind', mcpProjet, mcpProjet];
const inscriptibles = [profil.worktree, profil.gitCommun, profil.spool, profil.piecesJointes];

test.each([true, false])('base PTY=%s et absence de montages facultatifs', (pty) => {
  expect(argvBwrap(profil, { pty }, fsSimule())).toEqual([
    ...base,
    ...(pty ? ['--unsetenv', 'PWD'] : ['--new-session']),
    '--tmpfs',
    profil.aidHome,
    ...inscriptibles.flatMap((chemin) => ['--bind', chemin, chemin]),
    ...montagesProjet,
  ]);
});

test('monte les zones cachées, les exceptions inscriptibles sous AID_HOME et les recouvrements dans cet ordre', () => {
  const identites = ['.ssh', '.gnupg', '.config/gh'].map((p) => `${profil.home}/${p}`);
  const credentials = `${profil.home}/.git-credentials`;
  const etat = ['.npm', '.cache'].map((p) => `${profil.home}/${p}`);
  const cli = ['.claude', '.codex'].map((p) => `${profil.home}/${p}`);
  const sessions = cli.map((p) => `${p}/sessions`);
  const recouvrements = [
    '/depot/.git/config',
    '/depot/.git/hooks',
    '/depot/.git/refs/heads/main',
    '/depot/.git/packed-refs',
  ];
  const fs = fsSimule(
    [...identites, ...cli, ...sessions],
    [credentials, ...etat, ...recouvrements],
  );

  const args = argvBwrap(profil, { pty: true }, fs);
  const source = args[args.indexOf(credentials) - 1] ?? '';
  expect(args).toEqual([
    ...base,
    '--unsetenv',
    'PWD',
    '--tmpfs',
    profil.aidHome,
    ...identites.flatMap((chemin) => ['--tmpfs', chemin]),
    '--ro-bind',
    source,
    credentials,
    ...inscriptibles.flatMap((chemin) => ['--bind', chemin, chemin]),
    ...montagesProjet,
    ...etat.flatMap((chemin) => ['--bind', chemin, chemin]),
    ...cli.flatMap((chemin) => ['--ro-bind', chemin, chemin]),
    ...sessions.flatMap((chemin) => ['--bind', chemin, chemin]),
    ...recouvrements.flatMap((chemin) => ['--ro-bind', chemin, chemin]),
  ]);
  expect(source).not.toBe('/dev/null');
  const statut = lstatSync(source);
  expect(statut.isFile()).toBe(true);
  expect(statut.size).toBe(0);
  expect(statut.mode & 0o777).toBe(0o444);
  const cheminReel = realpathSync(source);
  for (const dossier of [profil.home, profil.worktree]) {
    expect(cheminReel).not.toBe(dossier);
    expect(cheminReel.startsWith(dossier + sep)).toBe(false);
  }
});

test('remonte la configuration du projet après le worktree', () => {
  const args = argvBwrap(profil, { pty: false }, fsSimule([claudeProjet], [mcpProjet]));
  const montage = args.indexOf(claudeProjet);
  expect(montage).toBeGreaterThan(args.lastIndexOf(profil.worktree));
  expect(args.slice(montage - 1, montage + 5)).toEqual(montagesProjet);
});

test.each([claudeProjet, mcpProjet])('refuse un lien symbolique au point %s', (chemin) => {
  const fs = {
    ...fsSimule(),
    lstatSync: (p: string) =>
      p === chemin ? { isDirectory: () => false, isFile: () => false } : undefined,
  };
  expect(() => argvBwrap(profil, { pty: false }, fs)).toThrow(chemin);
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
    '-c',
    'core.fsmonitor=false',
    '-c',
    'core.hooksPath=/dev/null',
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

test('recouvre les pointeurs Git et ne rend visible que le fichier DNS sous /run', () => {
  const gitDir = '/depot/.git/worktrees/sujet';
  const resolv = '/etc/resolv.conf';
  const cible = '/run/systemd/resolve/stub-resolv.conf';
  const pointeurs = [`${profil.worktree}/.git`, `${gitDir}/commondir`, `${gitDir}/gitdir`];
  const fs = {
    ...fsSimule([], [resolv, cible, ...pointeurs]),
    readlinkSync: () => '../run/systemd/resolve/stub-resolv.conf',
    realpathSync: () => cible,
  };
  const args = argvBwrap({ ...profil, gitDir }, { pty: false }, fs);
  expect(args.slice(args.indexOf('/run') - 1, args.indexOf('/run') + 2)).toEqual([
    '--tmpfs',
    '/run',
    '--die-with-parent',
  ]);
  expect(args.slice(args.indexOf(cible) - 1, args.indexOf(cible) + 2)).toEqual([
    '--ro-bind',
    cible,
    cible,
  ]);
  expect(args.slice(-9)).toEqual(pointeurs.flatMap((chemin) => ['--ro-bind', chemin, chemin]));
  expect(args).not.toContain('--unshare-net');
});
