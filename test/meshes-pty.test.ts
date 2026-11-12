import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../src/daemon/config.js';
import { makeTopic, setupWorkspace } from './helpers/topics.js';
import { waitFor } from './helpers/daemon.js';

// Le faux exécuteur restitue uniquement les variables pertinentes, jamais les AID_TOKEN des hooks.
const hostiles = [
  'MESH_GATEWAY_TOKEN',
  'SWARPH_GATEWAY',
  'SWARPH_STATE_ROOT',
  'SWARPH_SERVICE_TOKEN',
  'MESH_DB_PATH',
  'SWARPH_CHANNEL_CELL',
  'SWARPH_MEMORY_DIR',
  'GBRAIN_TOKEN',
  'SWARPH_BRAIN_TOKEN',
];
test('PTY swarph-cell : environnement reçu et une session par mesh, même cell et deux HOME', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aid-46-pty-'));
  const bin = join(home, 'swarph');
  writeFileSync(
    bin,
    `#!/bin/sh
if [ "$1" != spawn ]; then echo '{"running":false}'; exit 0; fi
for nom in HOME SWARPH_SELF SWARPH_STATE MESH_GATEWAY_URL SWARPH_BRAIN_GATEWAY ${hostiles.join(' ')}; do
  printenv "$nom" | sed "s|^|$nom=|"
done
echo FIN_ENV
while read -r ligne; do :; done
`,
    { mode: 0o755 },
  );
  for (const nom of [...hostiles, 'SWARPH_BRAIN_GATEWAY']) vi.stubEnv(nom, 'hostile');
  vi.stubEnv('PATH', `${home}:${process.env.PATH ?? ''}`);
  const c = await setupWorkspace({
    config: {
      mesh: { ...DEFAULT_CONFIG.mesh, bin: 'swarph' },
      meshes: Object.fromEntries(
        ['principal', 'perso'].map((nom) => [
          nom,
          {
            ...DEFAULT_CONFIG.mesh,
            cell: 'principal',
            home: join(home, nom),
            gateway: `https://${nom}.example.com`,
          },
        ]),
      ),
    },
  });
  try {
    vi.stubEnv('PATH', process.env.PATH!.split(':').slice(1).join(':'));
    const topic = await makeTopic(c);
    for (const nom of ['principal', 'perso']) {
      const r = await c.t.d.app.inject({
        method: 'POST',
        url: '/api/agents',
        headers: c.t.headers,
        payload: { topicId: topic.topicId, kind: 'swarph-cell', mesh: nom },
      });
      expect(r.statusCode).toBe(201);
      expect(r.json().command[0]).toBe(bin);
      const agent = c.t.d.agents.get(r.json().id)!;
      let sortie = '';
      agent.subscribe((s) => {
        sortie += s;
      });
      await waitFor(() => sortie.includes('FIN_ENV'), 5000, 'environnement du PTY');
      expect(sortie).toContain(`HOME=${join(home, nom)}`);
      expect(sortie).toContain('SWARPH_SELF=principal');
      expect(sortie).toContain(`SWARPH_STATE=${join(home, nom, 'swarph_state')}`);
      expect(sortie).toContain(`MESH_GATEWAY_URL=https://${nom}.example.com`);
      expect(sortie).toContain(`SWARPH_BRAIN_GATEWAY=https://${nom}.example.com`);
      for (const variable of hostiles) expect(sortie).not.toContain(`${variable}=`);
      expect(sortie).not.toContain('hostile');
      expect(() =>
        c.t.d.agents.spawn({ topicId: topic.topicId, kind: 'swarph-cell', mesh: nom }),
      ).toThrow('déjà ouverte');
    }
    expect(c.t.d.agents.liveAgents().filter((a) => a.kind === 'swarph-cell')).toHaveLength(2);
  } finally {
    await c.t.d.stop();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  }
});
