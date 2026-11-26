import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { Environnement } from '../../shared/model.js';
import { extraireVersion } from '../../shared/plage-version.js';

const OUTILS = ['node', 'npm', 'git', 'mise', 'docker', 'python3', 'cargo', 'ollama'] as const;
const CACHE_MS = 10 * 60 * 1000;

const executer = promisify(execFile);

interface SondesEnvironnement {
  maintenant?: () => number;
  exec?: (
    outil: string,
    args: string[],
    options: { timeout: number; killSignal: 'SIGKILL' },
  ) => Promise<{ stdout: string; stderr: string }>;
  fetch?: typeof fetch;
  procVersion?: () => Promise<string | null>;
}

async function lireModeles(url: string, requete: typeof fetch): Promise<string[] | null> {
  try {
    const reponse = await requete(`${url.replace(/\/$/, '')}/api/tags`, {
      method: 'GET',
      signal: AbortSignal.timeout(2000),
    });
    if (!reponse.ok) return null;
    const { models } = (await reponse.json()) as { models?: Array<{ name?: unknown } | null> };
    if (!Array.isArray(models)) return null;
    return models
      .flatMap((modele) => (typeof modele?.name === 'string' ? [modele.name] : []))
      .sort();
  } catch {
    return null;
  }
}

/** Une sonde par daemon, déclenchée à la demande. Le délai court à partir de la mesure. */
export function creerSondeEnvironnement(url: string, sondes: SondesEnvironnement = {}) {
  const maintenant = sondes.maintenant ?? Date.now;
  const exec = sondes.exec ?? executer;
  const requete = sondes.fetch ?? fetch;
  const procVersion = sondes.procVersion ?? (() => readFile('/proc/version', 'utf8'));
  let cache: { valeur: Environnement; expiration: number } | undefined;
  let enCours: Promise<Environnement> | undefined;

  async function mesurer(): Promise<Environnement> {
    const [versions, modelesOllama, versionNoyau] = await Promise.all([
      Promise.all(
        OUTILS.map(async (outil) => {
          try {
            const { stdout, stderr } = await exec(outil, ['--version'], {
              timeout: 3000,
              killSignal: 'SIGKILL',
            });
            return [outil, extraireVersion(stdout, stderr) ?? null] as const;
          } catch {
            return [outil, null] as const;
          }
        }),
      ),
      lireModeles(url, requete),
      process.platform === 'linux' ? procVersion().catch(() => null) : null,
    ]);
    const date = maintenant();
    const valeur: Environnement = {
      os: process.platform,
      arch: process.arch,
      ...(versionNoyau?.toLowerCase().includes('microsoft') && { wsl: true }),
      outils: Object.fromEntries(versions),
      modelesOllama,
      mesureA: new Date(date).toISOString(),
    };
    cache = { valeur, expiration: date + CACHE_MS };
    return valeur;
  }

  return (): Promise<Environnement> => {
    if (enCours) return enCours;
    if (cache && maintenant() < cache.expiration) return Promise.resolve(cache.valeur);
    enCours = mesurer().finally(() => {
      enCours = undefined;
    });
    return enCours;
  };
}
