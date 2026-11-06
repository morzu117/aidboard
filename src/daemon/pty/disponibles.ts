import { execFile } from 'node:child_process';
import { agentOptions, type ModelOption } from '../../shared/agentSettings.js';
import type { AgentDisponible, AgentsDisponibles } from '../../shared/model.js';
import { git } from '../git/exec.js';
import { resolveOnPath } from './spawn.js';

const VERSION_TIMEOUT_MS = 3000;

/**
 * Chantier 28 (D143) : `<bin> --version`, 3 s au plus. Jamais de shell ; un environnement réduit, rien du daemon
 * (ni token, ni secret) : la commande n'a besoin que de se trouver. Rend null en cas d'échec ou de délai dépassé.
 */
function lireVersion(file: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      file,
      ['--version'],
      {
        timeout: VERSION_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        maxBuffer: 64 * 1024,
        env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', LANG: 'C' },
      },
      (err, stdout) => {
        if (err) return resolve(null);
        const ligne = String(stdout).split('\n')[0]?.trim() ?? '';
        // « 2.1.0 (Claude Code) », « codex-cli 0.50.0 » : le numéro seul, sinon la ligne courte
        const numero = /\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/.exec(ligne)?.[0];
        resolve(numero ?? (ligne ? ligne.slice(0, 40) : null));
      },
    );
  });
}

async function disponible(
  kind: 'claude' | 'codex',
  codexModels: ModelOption[],
): Promise<AgentDisponible> {
  const file = resolveOnPath(kind, process.env.PATH ?? '');
  return {
    kind,
    trouve: file !== null,
    version: file ? await lireVersion(file) : null,
    options: agentOptions(kind, codexModels),
  };
}

/** D143 : `git rev-list --count <base>..origin/<base>`, sans fetch ; null si l'une des deux refs manque. */
async function retardDeBase(root: string, base: string): Promise<number | null> {
  const r = await git(root, ['rev-list', '--count', `${base}..origin/${base}`]);
  if (!r.ok) return null;
  const n = Number(r.stdout);
  return Number.isInteger(n) ? n : null;
}

/** Lecture seule, à l'ouverture de l'écran Nouveau sujet et au changement de projet. */
export async function agentsDisponibles(
  codexModels: ModelOption[],
  projet?: { root: string; base: string },
): Promise<AgentsDisponibles> {
  const [agents, baseEnRetard] = await Promise.all([
    Promise.all([disponible('claude', codexModels), disponible('codex', codexModels)]),
    projet ? retardDeBase(projet.root, projet.base) : Promise.resolve(null),
  ]);
  return { agents, baseEnRetard };
}
