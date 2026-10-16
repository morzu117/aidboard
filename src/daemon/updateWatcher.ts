import { checkForUpdate, repoRootFrom, type UpdateStatus } from './updateCheck.js';

const CHECK_MS = 30 * 60_000;

/** Vérifie en tâche de fond si origin/<branche> a avancé ; ne bloque jamais le démarrage ni une requête. */
export class UpdateWatcher {
  private last: UpdateStatus | null = null;
  private readonly timer: NodeJS.Timeout | undefined;

  constructor(from: string, branch = 'main') {
    const dir = repoRootFrom(from);
    if (!dir) return;
    const tick = () => void checkForUpdate(dir, branch).then((s) => (this.last = s));
    tick();
    this.timer = setInterval(tick, CHECK_MS);
    this.timer.unref();
  }

  status(): UpdateStatus | null {
    return this.last;
  }

  dispose(): void {
    clearInterval(this.timer);
  }
}
