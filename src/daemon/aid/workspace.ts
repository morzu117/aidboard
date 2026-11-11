import { execFile } from 'node:child_process';
import type { Workspace } from '../../shared/model.js';
import { GIT_ENV } from '../git/exec.js';

/** Ni les erreurs git ni son URL ne sortent de cette fonction. */
export function lireIdentite(root: string, remote: string, delaiMs = 5000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['remote', 'get-url', remote],
      {
        cwd: root,
        env: { ...process.env, ...GIT_ENV },
        timeout: delaiMs,
        maxBuffer: 16 * 1024,
      },
      (erreur, stdout) => {
        if (erreur) return resolve(null);
        const correspondance =
          /^(?:https:\/\/(?:[^\s/@]+@)?github\.com\/|ssh:\/\/git@github\.com(?::22)?\/|git@github\.com:)([A-Za-z0-9._-]{1,100})\/([A-Za-z0-9._-]{1,104})\/?$/.exec(
            stdout.trim(),
          );
        if (!correspondance) return resolve(null);
        const depot = correspondance[2]!.replace(/\.git$/, '');
        resolve(depot.length > 0 && depot.length <= 100 ? `${correspondance[1]}/${depot}` : null);
      },
    );
  });
}

export class IdentitesWorkspaces {
  private cache = new Map<string, { signature: string; valeur: Promise<string | null> }>();

  constructor(private lire = lireIdentite) {}

  lireWorkspace(workspace: Pick<Workspace, 'id' | 'root' | 'remote'>): Promise<string | null> {
    const signature = JSON.stringify(workspace);
    const precedent = this.cache.get(workspace.id);
    if (precedent?.signature === signature) return precedent.valeur;
    const valeur = workspace.remote
      ? this.lire(workspace.root, workspace.remote)
      : Promise.resolve(null);
    this.cache.set(workspace.id, { signature, valeur });
    return valeur;
  }
}
