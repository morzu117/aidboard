import * as fsReel from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { SpawnChild } from '../src/daemon/conversation/driver.js';
import { argvBwrap } from '../src/daemon/isolation/bwrap.js';
import { envelopper, profilPour, spawnChildIsole } from '../src/daemon/isolation/lanceur.js';
import { sonderBwrap } from '../src/daemon/isolation/sonde.js';
import { resolvePaths } from '../src/daemon/paths.js';

const fs = {
  existsSync: () => false,
  statSync: () => {
    throw new Error('chemin absent');
  },
};
const paths = resolvePaths('/aid-test');
const profil = profilPour(
  { worktree: '/sujet', home: '/home/test', paths, agentId: 'ag_test' },
  () => '/depot/.git\n',
  fs,
);

it('construit le profil et enveloppe la commande PTY', () => {
  expect(profil).toEqual({
    worktree: '/sujet',
    gitCommun: '/depot/.git',
    home: '/home/test',
    aidHome: '/aid-test',
    spool: '/aid-test/spool',
    piecesJointes: '/aid-test/attachments/ag_test',
  });
  expect(envelopper('/bin/bwrap', profil, { pty: true }, fs, '/bin/sh', ['-l'])).toEqual({
    file: '/bin/bwrap',
    args: [...argvBwrap(profil, { pty: true }, fs), '--', '/bin/sh', '-l'],
  });
});

it.each([true, false])('ajoute seulement la configuration MCP stricte en PTY=%s', (pty) => {
  expect(envelopper('/bin/bwrap', profil, { pty }, fs, '/bin/claude', ['--']).args).toEqual([
    ...argvBwrap(profil, { pty }, fs),
    '--',
    '/bin/claude',
    '--strict-mcp-config',
    '--',
  ]);
});

it.each([{ sources: ['--setting-sources', 'user'] }, { sources: ['--setting-sources=user'] }])(
  'conserve les options Claude déjà présentes (%j)',
  ({ sources }) => {
    const args = [...sources, '--strict-mcp-config'];
    expect(envelopper('/bin/bwrap', profil, { pty: true }, fs, 'claude', args).args).toEqual([
      ...argvBwrap(profil, { pty: true }, fs),
      '--',
      'claude',
      ...args,
    ]);
  },
);

it.each([true, false])('passe la confiance Codex par argv en PTY=%s', (pty) => {
  const args = pty ? [] : ['app-server'];
  expect(envelopper('/bin/bwrap', profil, { pty }, fs, 'codex', args).args).toEqual([
    ...argvBwrap(profil, { pty }, fs),
    '--',
    'codex',
    '-c',
    'projects={"/sujet"={trust_level="trusted"}}',
    ...args,
  ]);
});

it('attend le dernier lancement et conserve les points modifiés sur l’hôte', () => {
  const worktree = fsReel.mkdtempSync(join(tmpdir(), 'aid-points-'));
  const home = join(worktree, 'home');
  fsReel.mkdirSync(home);
  const claude = join(worktree, '.claude');
  const mcp = join(worktree, '.mcp.json');
  const lancer = () =>
    envelopper('/bin/bwrap', { ...profil, home, worktree }, { pty: false }, fsReel, 'claude', []);
  try {
    const premier = lancer();
    const second = lancer();
    premier.nettoyer?.();
    expect(fsReel.existsSync(claude)).toBe(true);
    expect(fsReel.existsSync(mcp)).toBe(true);
    second.nettoyer?.();
    expect(fsReel.existsSync(claude)).toBe(false);
    expect(fsReel.existsSync(mcp)).toBe(false);

    const modifie = lancer();
    fsReel.writeFileSync(join(claude, 'temoin'), 'initial');
    fsReel.writeFileSync(mcp, '{}');
    modifie.nettoyer?.();
    expect(fsReel.readFileSync(join(claude, 'temoin'), 'utf8')).toBe('initial');
    expect(fsReel.readFileSync(mcp, 'utf8')).toBe('{}');
  } finally {
    fsReel.rmSync(worktree, { recursive: true, force: true });
  }
});

it('monte uniquement le projet canonique et sa mémoire, même avec cent transcriptions', () => {
  const racine = fsReel.mkdtempSync(join(tmpdir(), 'aid-projets-'));
  const home = join(racine, 'home');
  const worktree = join(racine, 'sujet_é.1');
  const alias = join(racine, 'alias');
  fsReel.mkdirSync(home);
  fsReel.mkdirSync(worktree);
  fsReel.symlinkSync(worktree, alias);
  const projets = join(home, '.claude/projects');
  const projet = join(
    projets,
    fsReel.realpathSync(racine).replace(/[^A-Za-z0-9]/g, '-') + '-sujet---1',
  );
  const memoire = join(projet, 'memory');
  fsReel.mkdirSync(join(projets, 'autre'), { recursive: true });
  fsReel.mkdirSync(join(home, '.claude/todos'));
  const lancer = () => {
    const lancement = envelopper(
      '/bin/bwrap',
      { ...profil, home, worktree: alias },
      { pty: false },
      fsReel,
      'claude',
      [],
    );
    lancement.nettoyer?.();
    return lancement.args;
  };
  try {
    const avant = lancer();
    expect(fsReel.statSync(memoire).isDirectory()).toBe(true);
    for (let i = 0; i < 100; i++) {
      const dossier = i % 2 === 0 ? projet : join(projets, 'autre');
      fsReel.writeFileSync(
        join(dossier, `00000000-0000-0000-0000-${String(i).padStart(12, '0')}.jsonl`),
        '',
      );
    }
    expect(lancer()).toEqual(avant);
    const montage = avant.indexOf(projet);
    expect(avant.slice(montage - 1, montage + 5)).toEqual([
      '--bind',
      projet,
      projet,
      '--ro-bind',
      memoire,
      memoire,
    ]);
    expect(montage).toBeGreaterThan(avant.lastIndexOf(join(home, '.claude')));
    expect(avant).not.toContain(join(projets, 'autre'));
    const todos = avant.indexOf(join(home, '.claude/todos'));
    expect(avant[todos - 1]).toBe('--tmpfs');
  } finally {
    fsReel.rmSync(racine, { recursive: true, force: true });
  }
});

it('transmet les options du pilote et renvoie son processus', () => {
  const child = {} as ReturnType<SpawnChild>;
  const spawn = vi.fn<SpawnChild>().mockReturnValue(child);
  const options: Parameters<SpawnChild>[2] = {
    cwd: '/sujet',
    env: { HOME: '/home/test' },
    stdio: ['pipe', 'pipe', 'pipe'],
  };
  expect(spawnChildIsole('/bin/bwrap', profil, fs, spawn)('/bin/sh', ['-l'], options)).toBe(child);
  expect(spawn).toHaveBeenCalledExactlyOnceWith(
    '/bin/bwrap',
    [...argvBwrap(profil, { pty: false }, fs), '--', '/bin/sh', '-l'],
    options,
  );
});

it('filtre l’environnement transmis au lanceur isolé', () => {
  const enfant = {} as ReturnType<SpawnChild>;
  const spawn = vi.fn<SpawnChild>().mockReturnValue(enfant);
  const env = {
    HOME: '/home/test',
    LC_MESSAGES: 'C',
    AID_RUN: 'run_test',
    AID_SECRET_INTERNE: 'factice',
    XDG_RUNTIME_DIR: '/run/user',
    CODEX_HOME: '/autre-config',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
  spawnChildIsole(
    '/bin/bwrap',
    profil,
    fs,
    spawn,
  )('/bin/sh', [], {
    cwd: '/sujet',
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  expect(spawn.mock.calls[0]?.[2].env).toEqual({
    HOME: env.HOME,
    LC_MESSAGES: env.LC_MESSAGES,
    AID_RUN: env.AID_RUN,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  });
});

const prefixe = 'isolation demandée mais bubblewrap indisponible : ';
const resultat = { pid: 1, output: [], signal: null, stderr: '', stdout: '', status: 0 };

it('refuse une plateforme non Linux avant de chercher bwrap', () => {
  const chercher = vi.fn();
  expect(() => sonderBwrap({ platform: 'darwin', chercher })).toThrow(
    'isolation bwrap indisponible sur darwin',
  );
  expect(chercher).not.toHaveBeenCalled();
});

it('refuse un PATH sans bwrap', () => {
  expect(() => sonderBwrap({ platform: 'linux', path: '' })).toThrow(
    prefixe + 'bwrap absent du PATH',
  );
});

it('reprend la fin de stderr si la sonde échoue', () => {
  const exec = vi.fn(() => ({
    ...resultat,
    status: 1,
    stderr: `début ${'.'.repeat(500)}\nbwrap: espace de noms refusé\n`,
  }));
  expect(() => sonderBwrap({ platform: 'linux', chercher: () => '/bin/bwrap', exec })).toThrow(
    /bwrap: espace de noms refusé$/,
  );
  expect(exec).toHaveBeenCalledTimes(1);
});

it('sonde le binaire résolu puis conserve sa version', () => {
  const chercher = vi.fn(() => '/bin/bwrap');
  const exec = vi
    .fn()
    .mockReturnValueOnce(resultat)
    .mockReturnValueOnce({ ...resultat, stdout: 'bubblewrap 1.2.3\n' });
  expect(sonderBwrap({ platform: 'linux', path: '/bin', chercher, exec })).toEqual({
    bin: '/bin/bwrap',
    version: 'bubblewrap 1.2.3',
  });
  expect(chercher).toHaveBeenCalledWith('bwrap', '/bin');
  expect(exec).toHaveBeenNthCalledWith(
    1,
    '/bin/bwrap',
    ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--', '/bin/true'],
    5000,
  );
  expect(exec).toHaveBeenNthCalledWith(2, '/bin/bwrap', ['--version'], 5000);
});
