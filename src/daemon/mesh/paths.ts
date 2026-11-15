import { homedir } from 'node:os';
import { join } from 'node:path';
import type { MeshConfig } from '../config.js';

/** Chemins swarph dérivés de la config (D39) : ce qu'A-I-D regarde, jamais ce qu'il lit (le token). */
export interface MeshPaths {
  /** `~/.config/swarph/cells/<cell>.yaml`, ou `mesh.cellFile` s'il est posé */
  cellFile: string;
  /** `~/.config/swarph/<cell>.peer_token` : son existence se vérifie, son contenu ne se lit jamais */
  tokenFile: string;
  /** `$SWARPH_STATE` que le daemon pose : `~/swarph_state`, ou `mesh.stateRoot` */
  stateRoot: string;
  /** `<stateRoot>/<cell>/mesh-sidecar/inbox.log`, ce que suit 12.3 */
  inboxLog: string;
}

export function meshPaths(
  cfg: Pick<MeshConfig, 'cell' | 'home' | 'cellFile' | 'stateRoot' | 'inboxLog'>,
  home = process.env.HOME ?? homedir(),
): MeshPaths {
  home = cfg.home ?? home;
  const confDir = join(home, '.config', 'swarph');
  const stateRoot = cfg.stateRoot || join(home, 'swarph_state');
  return {
    cellFile: cfg.cellFile || join(confDir, 'cells', `${cfg.cell}.yaml`),
    tokenFile: join(confDir, `${cfg.cell}.peer_token`),
    stateRoot,
    inboxLog: cfg.inboxLog || join(stateRoot, cfg.cell, 'mesh-sidecar', 'inbox.log'),
  };
}
