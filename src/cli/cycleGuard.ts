/**
 * Garde du cycle `aid --cycle` : un second déclenchement pendant qu'un cycle tourne est ignoré (sinon deux
 * `spawnRespawnWatcher` se battent pour le même port). Si le cycle lève avant la relance, l'erreur est journalisée et la
 * garde retombe : le daemon reste vivant, il doit pouvoir accepter un nouveau cycle. Si le cycle aboutit, le process
 * s'arrête de lui-même, la garde reste donc levée.
 */
export function cycleGuard(run: () => Promise<void>, log: (message: string) => void): () => void {
  let cycling = false;
  return () => {
    if (cycling) return;
    cycling = true;
    run().catch((err: unknown) => {
      log(`cycle échoué : ${err instanceof Error ? err.message : String(err)}`);
      cycling = false;
    });
  };
}
