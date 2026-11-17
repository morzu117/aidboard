import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { appartientAuDaemonAudit } from '../e2e/audit/identite-processus.js';

it('refuse un PID étranger ou disparu, accepte seulement une preuve du CLI ou du home', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aid-audit-identite-'));
  const cli = join(import.meta.dirname, '../dist/cli/aid.js');
  try {
    expect(appartientAuDaemonAudit(process.pid, home)).toBe(false);
    expect(appartientAuDaemonAudit(2147483647, home)).toBe(false);
    for (const preuve of ['home', 'cli']) {
      // Le chemin CLI n'est qu'un argument de ce faux processus, jamais exécuté.
      const enfant = spawn(
        process.execPath,
        ['-e', 'setInterval(() => {}, 1000)', '--', ...(preuve === 'cli' ? [cli] : [])],
        {
          env: { ...process.env, AID_HOME: preuve === 'home' ? home : '' },
          stdio: 'ignore',
        },
      );
      try {
        await once(enfant, 'spawn');
        expect(appartientAuDaemonAudit(enfant.pid!, home)).toBe(true);
      } finally {
        const fin = once(enfant, 'exit');
        enfant.kill('SIGTERM');
        await fin;
      }
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
