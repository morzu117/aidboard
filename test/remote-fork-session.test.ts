import { expect, test } from 'vitest';
import type { ConversationDriver, ConversationEvent } from '../src/daemon/conversation/driver.js';
import { RemoteDriver } from '../src/daemon/remote/driver.js';
import type { RemoteChild } from '../src/daemon/remote/child.js';

test('perte du relais après init : reprendre l’UUID du fork, même avant le premier tour', () => {
  const mounts: { sessionId: string; resume: boolean }[] = [];
  const listeners: ((event: ConversationEvent) => void)[] = [];
  const driver = new RemoteDriver({
    server: {
      mode: 'ssh_alias',
      target: 'faux',
      sshOptions: null,
      loadProfile: false,
      shell: 'sh',
    },
    transport: { ssh: '/jamais-lancé' },
    relayId: 'test',
    sessionId: 'source',
    resume: true,
    create(options): ConversationDriver {
      mounts.push(options);
      return {
        sessionId: options.sessionId,
        start() {},
        send() {},
        interrupt() {},
        answer() {},
        configure() {},
        async stop() {},
        onEvent(cb) {
          listeners.push(cb);
          return () => {};
        },
      };
    },
  });
  driver.start();
  listeners[0]!({ type: 'session', sessionId: 'fork-neuf' });
  expect(driver.sessionId).toBe('fork-neuf');
  // Le pilote du protocole garde son id de lancement ; l’événement init doit primer dessus.
  (driver as unknown as { child: Pick<RemoteChild, 'lost' | 'lostSince'> }).child = {
    lost: true,
    lostSince: Date.now(),
  };
  listeners[0]!({ type: 'exit', code: 1, signal: null });
  expect(mounts.map(({ sessionId, resume }) => ({ sessionId, resume }))).toEqual([
    { sessionId: 'source', resume: true },
    { sessionId: 'fork-neuf', resume: true },
  ]);
});
