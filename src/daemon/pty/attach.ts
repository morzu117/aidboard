import type { LiveAgent } from './manager.js';

export interface Attachment {
  detach(): void;
  /** Résolu quand l'instantané et la sortie arrivée pendant son calcul ont été envoyés. */
  ready: Promise<void>;
}

// Un client reçoit : l'instantané de l'écran, puis le direct. Chaque octet est soit dans l'instantané,
// soit dans le direct, jamais dans les deux : le miroir a reçu tout ce qui précède la barrière, le
// client tout ce qui la suit.
export function attachClient(live: LiveAgent, send: (data: string) => void): Attachment {
  let pending: string[] | null = [];
  const unsubscribe = live.subscribe((chunk) => {
    if (pending) pending.push(chunk);
    else send(chunk);
  });
  const ready = new Promise<void>((resolve) => {
    live.mirror.snapshotThen((snapshot) => {
      send(snapshot);
      for (const chunk of pending ?? []) send(chunk);
      pending = null;
      resolve();
    });
  });
  return { detach: unsubscribe, ready };
}
