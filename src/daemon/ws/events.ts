import type { FastifyInstance } from 'fastify';
import type { EventStore } from '../events/store.js';
import type { StoredEvent } from '../../shared/events.js';

export interface EphemeralMessage {
  kind: 'ephemeral';
  type: string;
  topicId?: string;
  [key: string]: unknown;
}

export function registerEventSocket(app: FastifyInstance, store: EventStore): void {
  app.get('/ws/events', { websocket: true }, (socket, req) => {
    const q = req.query as { since?: string; topicId?: string; runId?: string };
    const filter = { topicId: q.topicId, runId: q.runId };
    const wanted = (e: StoredEvent) =>
      (!filter.topicId || e.topicId === filter.topicId) &&
      (!filter.runId || e.runId === filter.runId);
    let lastSeq = 0;
    const send = (e: StoredEvent) => {
      if (e.seq <= lastSeq) return;
      lastSeq = e.seq;
      socket.send(JSON.stringify({ kind: 'event', event: e }));
    };
    const onEvent = (e: StoredEvent) => {
      if (wanted(e)) send(e);
    };
    const onEphemeral = (m: EphemeralMessage) => {
      if (!filter.topicId || m.topicId === filter.topicId) socket.send(JSON.stringify(m));
    };
    // S'abonner d'abord, puis rejouer : tout est synchrone, donc aucun événement ne passe entre les deux.
    store.on('event', onEvent);
    store.on('ephemeral', onEphemeral);
    for (const e of store.since(q.since ?? null, filter)) send(e);
    socket.on('close', () => {
      store.off('event', onEvent);
      store.off('ephemeral', onEphemeral);
    });
  });
}
