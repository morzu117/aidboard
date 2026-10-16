import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

export function onPath(bin: string, pathVar = process.env.PATH ?? ''): boolean {
  return pathVar.split(delimiter).some((dir) => {
    try {
      accessSync(join(dir, bin), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

export function defaultEditor(platform: NodeJS.Platform, hasCode: boolean): string[] {
  if (hasCode) return ['code', '{path}'];
  if (platform === 'darwin') return ['open', '-a', 'Visual Studio Code', '{path}'];
  return ['xdg-open', '{path}'];
}

export function editorCommand(configured: string[], platform = process.platform): string[] {
  return configured.length > 0 ? configured : defaultEditor(platform, onPath('code'));
}

// spawn(fichier, args) : le chemin arrive comme un seul argument, jamais interprété par un shell.
export function openInEditor(cmd: string[], path: string): Promise<void> {
  const [file, ...args] = cmd;
  if (!file) return Promise.reject(new Error('commande d’éditeur vide'));
  return new Promise((resolve, reject) => {
    const child = spawn(
      file,
      args.map((a) => (a === '{path}' ? path : a)),
      {
        detached: true,
        stdio: 'ignore',
      },
    );
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
