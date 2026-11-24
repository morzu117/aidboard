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
  expect(spawn.mock.calls[0]?.[2]).toBe(options);
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
