import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { DEFAULT_CONFIG } from '../src/daemon/config.js';
import { makeTopic, setupWorkspace } from './helpers/topics.js';
import { waitFor } from './helpers/daemon.js';

test('swarph-cell : échec sous le home du mesh remonté à la session, sans repli', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aid-46-pty-'));
  const bin = join(home, 'swarph');
  writeFileSync(
    bin,
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo exemple; exit 0; fi\nif [ "$1" = "spawn" ]; then echo erreur-interpréteur >&2; echo tentative > "$HOME/tentative"; exit 127; fi\necho \'{"running":false}\'\n',
    { mode: 0o755 },
  );
  const c = await setupWorkspace({
    config: {
      mesh: { ...DEFAULT_CONFIG.mesh, bin, cell: 'peer-a', home, gateway: 'https://example.com' },
    },
  });
  try {
    const topic = await makeTopic(c);
    const agent = c.t.d.agents.spawn({ topicId: topic.topicId, kind: 'swarph-cell' });
    const evenement = await waitFor(
      () => c.t.store.since(null).find((e) => e.type === 'agent.exited' && e.agentId === agent.id),
      10000,
      'échec de la session',
    );
    expect(evenement.data).toMatchObject({ exitCode: 127, reason: 'exit' });
    expect(c.t.d.agents.get(agent.id)!.exit).toMatchObject({ exitCode: 127 });
    expect(existsSync(join(home, 'tentative'))).toBe(true);
    expect(
      c.t.store.since(null).filter((e) => e.type === 'agent.spawned' && e.agentId === agent.id),
    ).toHaveLength(1);
  } finally {
    await c.t.d.stop();
    rmSync(home, { recursive: true, force: true });
  }
});
