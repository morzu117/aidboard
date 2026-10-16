import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export default async function globalTeardown() {
  const home = process.env.AID_E2E_HOME;
  if (!home) return;
  try {
    execFileSync(
      process.execPath,
      [join(import.meta.dirname, '../dist/cli/aid.js'), 'stop', '--force'],
      {
        env: { ...process.env, AID_HOME: home },
        timeout: 30_000,
      },
    );
  } catch {
    if (process.env.AID_E2E_PID) process.kill(Number(process.env.AID_E2E_PID), 'SIGKILL');
  }
}
