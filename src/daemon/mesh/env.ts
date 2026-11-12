import { homedir } from 'node:os';
import type { MeshConfig } from '../config.js';
import { meshPaths } from './paths.js';

/** D314 : seules les variables sans effet sur la destination sont héritées. */
export function envSwarph(
  mesh: Pick<MeshConfig, 'home' | 'cell' | 'gateway' | 'stateRoot' | 'cellFile' | 'inboxLog'>,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [nom, valeur] of Object.entries(source))
    if (/^(PATH|LANG|LC_.*|TMPDIR|USER|LOGNAME|SHELL)$/.test(nom) && valeur !== undefined)
      env[nom] = valeur;
  env.HOME = mesh.home ?? source.HOME ?? homedir();
  env.SWARPH_STATE = meshPaths(mesh, env.HOME).stateRoot;
  env.SWARPH_SELF = mesh.cell;
  if (mesh.gateway) {
    env.MESH_GATEWAY_URL = mesh.gateway;
    env.SWARPH_BRAIN_GATEWAY = mesh.gateway;
  }
  return env;
}
