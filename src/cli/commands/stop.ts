import { daemonFetch, pidAlive, type DaemonInfo } from '../daemonInfo.js';

// 0 arrêté, 1 erreur, 2 refus : des agents tournent encore et --force n'est pas posé.
export async function stopDaemon(
  info: DaemonInfo | null,
  force: boolean,
  out: (s: string) => void = console.log,
  timeoutMs = 15_000,
): Promise<number> {
  if (!info) {
    out('daemon arrêté');
    return 0;
  }
  const { status, json } = await daemonFetch(
    info,
    'POST',
    '/api/daemon/stop',
    force ? { force: true } : {},
  );
  if (status === 409) {
    out(String(json.error));
    for (const a of ((json.agents as unknown[] | undefined) ?? []) as Array<{
      id: string;
      kind: string;
    }>)
      out(`  ${a.kind} ${a.id}`);
    return 2;
  }
  if (status !== 202) {
    out(`arrêt refusé (${status}) : ${String(json.error ?? '')}`);
    return 1;
  }
  const deadline = Date.now() + timeoutMs;
  while (pidAlive(info.pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  if (pidAlive(info.pid)) {
    out(`le daemon (pid ${info.pid}) ne s'est pas arrêté`);
    return 1;
  }
  out('daemon arrêté');
  return 0;
}
