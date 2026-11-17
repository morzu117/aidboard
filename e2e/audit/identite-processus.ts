import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CLI = join(import.meta.dirname, '../../dist/cli/aid.js');

/** Un daemon.json périmé ne doit jamais autoriser la mort d'un processus étranger. */
export function appartientAuDaemonAudit(pid: number, home: string): boolean {
  if (!Number.isInteger(pid) || pid <= 1 || !home) return false;
  try {
    if (readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').includes(CLI)) return true;
  } catch {
    // Processus disparu ou /proc inaccessible : vérifier l'autre preuve sans exposer son contenu.
  }
  try {
    return readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(`AID_HOME=${home}`);
  } catch {
    return false;
  }
}
