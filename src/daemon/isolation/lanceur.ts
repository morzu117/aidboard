import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { SpawnChild } from '../conversation/driver.js';
import type { AidPaths } from '../paths.js';
import { argvBwrap, gitCommunDe, type ProfilIsolation } from './bwrap.js';

type FsIsolation = Parameters<typeof argvBwrap>[2];

export function profilPour(
  {
    worktree,
    home,
    paths,
    agentId,
  }: {
    worktree: string;
    home: string;
    paths: AidPaths;
    agentId: string;
  },
  exec: Parameters<typeof gitCommunDe>[1],
  fs: FsIsolation,
): ProfilIsolation {
  const profil = {
    worktree,
    gitCommun: gitCommunDe(worktree, exec),
    home,
    aidHome: paths.home,
    spool: paths.spool,
    piecesJointes: join(paths.attachments, agentId),
  };
  // Valide les chemins avant que le manager ne démarre le pilote.
  argvBwrap(profil, { pty: false }, fs);
  return profil;
}

export function envelopper(
  bwrapBin: string,
  profil: ProfilIsolation,
  { pty }: { pty: boolean },
  fs: FsIsolation,
  file: string,
  args: string[],
): { file: string; args: string[] } {
  return { file: bwrapBin, args: [...argvBwrap(profil, { pty }, fs), '--', file, ...args] };
}

export function spawnChildIsole(
  bwrapBin: string,
  profil: ProfilIsolation,
  fs: FsIsolation,
  spawnChild: SpawnChild = spawn,
): SpawnChild {
  const argv = argvBwrap(profil, { pty: false }, fs);
  return (bin, args, options) => spawnChild(bwrapBin, [...argv, '--', bin, ...args], options);
}
