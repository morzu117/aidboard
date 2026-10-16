import { spawn } from 'node:child_process';
import { onPath } from '../daemon/actions/editor.js';

export interface BrowserEnv {
  platform: NodeJS.Platform;
  procVersion: string | null;
  has(bin: string): boolean;
  url: string;
}

export function isWsl(procVersion: string | null): boolean {
  return procVersion?.toLowerCase().includes('microsoft') ?? false;
}

// L'URL est toujours en 127.0.0.1 : « localhost » peut se résoudre en ::1 côté navigateur Windows.
export function browserCommand(e: BrowserEnv): string[] | null {
  if (e.platform === 'darwin') return ['open', e.url];
  if (isWsl(e.procVersion)) {
    if (e.has('wslview')) return ['wslview', e.url];
    return e.has('cmd.exe') ? ['cmd.exe', '/c', 'start', '""', e.url] : null;
  }
  return e.has('xdg-open') ? ['xdg-open', e.url] : null;
}

export async function openBrowser(url: string): Promise<boolean> {
  const { readProcVersion } = await import('../daemon/routes/workspaces.js');
  const cmd = browserCommand({
    platform: process.platform,
    procVersion: readProcVersion(),
    has: (b) => onPath(b),
    url,
  });
  if (!cmd) return false;
  const [file, ...args] = cmd as [string, ...string[]];
  return new Promise((resolve) => {
    const child = spawn(file, args, { detached: true, stdio: 'ignore' });
    child.once('error', () => resolve(false));
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}
