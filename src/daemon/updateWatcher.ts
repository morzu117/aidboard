import type { InstallMode } from '../shared/model.js';
import { latestRelease, newerThan, type Release } from './releaseCheck.js';
import { checkForUpdate, repoRootFrom } from './updateCheck.js';

const CHECK_MS = 30 * 60_000;

/** Ce que le watcher sait : `latest` est un sha d'origin/main (repo) ou une version (release). */
export interface WatchStatus {
  available: boolean;
  latest: string | null;
  /** mode release seulement : la release vue, avec ses assets, pour l'installer (13.5) */
  release?: Release;
}

/**
 * Vérifie en tâche de fond si une mise à jour existe ; ne bloque jamais le démarrage ni une
 * requête. La stratégie suit le mode d'installation (13.4, DR5) : `repo` compare HEAD à
 * origin/<branche> ; `release` interroge les releases GitHub ; `inconnu` ne fait rien.
 */
export class UpdateWatcher {
  private last: WatchStatus | null = null;
  private readonly timer: NodeJS.Timeout | undefined;
  private readonly check: (() => Promise<WatchStatus | null>) | null;

  constructor(opts: {
    mode: InstallMode;
    /** mode repo : un chemin sous le clone (le build qui tourne) */
    from: string;
    /** mode release : la version qui tourne */
    version: string;
    branch?: string;
    fetchFn?: typeof fetch;
    releasesUrl?: string;
    intervalMs?: number;
  }) {
    this.check = UpdateWatcher.strategy(opts);
    if (!this.check) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), opts.intervalMs ?? CHECK_MS);
    this.timer.unref();
  }

  private static strategy(opts: {
    mode: InstallMode;
    from: string;
    version: string;
    branch?: string;
    fetchFn?: typeof fetch;
    releasesUrl?: string;
  }): (() => Promise<WatchStatus | null>) | null {
    if (opts.mode === 'repo') {
      const dir = repoRootFrom(opts.from);
      if (!dir) return null;
      return async () => {
        const s = await checkForUpdate(dir, opts.branch ?? 'main');
        return s && { available: s.available, latest: s.remoteSha };
      };
    }
    if (opts.mode === 'release') {
      return async () => {
        const release = await latestRelease(opts.fetchFn, opts.releasesUrl);
        if (!release) return null;
        return {
          available: newerThan(opts.version, release.version),
          latest: release.version,
          release,
        };
      };
    }
    return null;
  }

  /** une vérification, tout de suite (les tests l'attendent plutôt que l'intervalle) */
  async tick(): Promise<WatchStatus | null> {
    if (this.check) this.last = await this.check();
    return this.last;
  }

  status(): WatchStatus | null {
    return this.last;
  }

  dispose(): void {
    clearInterval(this.timer);
  }
}
