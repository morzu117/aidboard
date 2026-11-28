import * as fs from 'node:fs';
import { delimiter, join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { runDoctor, type Probes } from '../src/cli/commands/doctor.js';
import { ServiceBoucle } from '../src/daemon/boucle/service.js';
import { resolvePaths } from '../src/daemon/paths.js';
import { limitesBoucle } from '../src/shared/limites-boucle.js';
import { poserOrigineBoucle, poserTemoinGitBoucle } from './boucle/temoin-git.js';
import { seedTopic, startTestDaemon } from './helpers/daemon.js';
import { commitFile, makeOriginAndClone, sh } from './helpers/git.js';
import { utiliserBac } from './isolation-acceptation-temoins.js';

const bac = utiliserBac();
const sujet = 'tp_1';

test('le daemon escalade si bwrap disparaît avant le gate et ne lance pas sa commande', async () => {
  const { racine } = bac();
  const { clone } = makeOriginAndClone(racine, { name: 'depot-fictif' });
  commitFile(
    clone,
    'agent.yml',
    `project: { namespace: aid }
phases: [plan, dev, review]
capabilities: { dev_agent: claude, review_agent: codex }
gates: { gate: ": > temoin-gate" }
`,
  );
  sh(clone, 'push', '-q', 'origin', 'main');
  const worktree = join(racine, 'sujet');
  sh(clone, 'worktree', 'add', '-qb', 'feat/s', worktree, 'main');
  poserOrigineBoucle(worktree);
  const bin = join(racine, 'bin');
  fs.mkdirSync(bin);
  const bwrap = join(bin, 'bwrap');
  fs.writeFileSync(
    bwrap,
    `#!/bin/sh
case "$1" in
  --version) echo 'bubblewrap test'; exit 0 ;;
esac
while [ "$#" -gt 0 ] && [ "$1" != -- ]; do shift; done
shift
exec "$@"
`,
    { mode: 0o700 },
  );
  for (const nom of ['claude', 'codex']) {
    fs.writeFileSync(join(bin, nom), '#!/bin/sh\nexec /bin/cat\n', { mode: 0o700 });
  }
  vi.stubEnv('PATH', poserTemoinGitBoucle(racine, worktree, undefined, bin).chemin);
  const daemon = await startTestDaemon(join(racine, 'aid'), {
    config: { agents: { isolation: 'bwrap' } },
    sondeBwrap: { platform: 'linux' },
  });
  try {
    const { d, db, headers } = daemon;
    seedTopic(db);
    db.prepare('DELETE FROM agents').run();
    db.prepare('UPDATE workspaces SET root = ?, worktrees_dir = ?').run(clone, racine);
    db.prepare('UPDATE topics SET worktree = ? WHERE id = ?').run(worktree, sujet);
    const lancer = vi.spyOn(ServiceBoucle.prototype, 'lancer');
    // Les faux agents restent en attente. Le test injecte uniquement leurs fins de tour.
    vi.spyOn(d.agents, 'ecrireBoucle').mockImplementation(() => {});
    const debut = await d.app.inject({
      method: 'POST',
      url: `/api/topics/${sujet}/boucle`,
      headers,
    });
    expect(debut.statusCode).toBe(200);
    const boucle = lancer.mock.contexts[0] as ServiceBoucle;
    const plan = boucle.lire(sujet);
    expect(plan).toMatchObject({ phase: 'plan', etapeCourante: { type: 'plan' } });
    await d.memory.put(
      'aid/plan/s',
      '## Point exemple\nModifier la note.',
      { kind: 'create' },
      { author: 'test' },
    );
    await boucle.traiterEvenementAgent(plan!.etapeCourante!.agentId!, { type: 'turn_end' });
    expect(boucle.lire(sujet)).toMatchObject({ phase: 'attente_go' });
    await boucle.go(sujet);
    const dev = boucle.lire(sujet);
    expect(dev).toMatchObject({ phase: 'dev', etapeCourante: { type: 'dev' } });
    commitFile(worktree, 'note.md', 'Une note.');
    await d.memory.put(
      'aid/dev-handoff/s',
      'Note ajoutée.',
      { kind: 'create' },
      { author: 'test' },
    );
    fs.unlinkSync(bwrap);
    expect(
      process.env.PATH?.split(delimiter).every((dossier) => !fs.existsSync(join(dossier, 'bwrap'))),
    ).toBe(true);
    await boucle.traiterEvenementAgent(dev!.etapeCourante!.agentId!, { type: 'turn_end' });
    const etat = boucle.lire(sujet);
    expect({
      phase: etat?.phase,
      temoinGate: fs.existsSync(join(worktree, 'temoin-gate')),
    }).toEqual({ phase: 'escalade', temoinGate: false });
    expect(JSON.stringify(etat)).toMatch(/isolation demandée mais bubblewrap indisponible/i);
  } finally {
    await daemon.d.stop();
  }
}, 25_000);

const sondes: Probes = {
  nodeVersion: 'v22.23.3',
  platform: 'linux',
  procVersion: null,
  has: () => true,
  version: async () => 'git version 2.54.0',
  loadPty: async () => null,
  loadSqlite: async () => null,
  homeMode: () => 0o40700,
  port: async () => ({ port: 4870, state: 'libre' }),
  artefactsPort: async () => ({ port: 4880, state: 'libre' }),
  claudeHooks: () => true,
  memoryHealth: async () => null,
  mcpRegistration: () => false,
  structural: async () => null,
  install: () => ({ mode: 'repo', version: null }),
  mesh: async () => null,
  swairm: async () => null,
  modeHost: async () => null,
  bwrapVersion: async () => 'bubblewrap 1.2.3',
};

async function lignesDoctor(racine: string) {
  const sortie: string[] = [];
  await runDoctor(resolvePaths(join(racine, 'aid')), sondes, (ligne) => sortie.push(ligne));
  return sortie;
}

test('doctor précise que le réseau et les sockets Unix abstraites restent accessibles avec bwrap', async () => {
  const sortie = await lignesDoctor(bac().racine);
  expect(sortie.join('\n')).toMatch(/Isolation : bwrap/);
  expect(sortie.join('\n')).toMatch(/réseau (?:reste ouvert|(?:n’est|n'est) pas isolé)/i);
  expect(sortie.join('\n')).toMatch(/sockets? Unix abstraite?s?/i);
});

test('la limite partagée affichée par doctor indique que bwrap couvre le gate', async () => {
  const sortie = await lignesDoctor(bac().racine);
  expect(sortie).toContain(`  Boucle — ${limitesBoucle}`);
  expect(limitesBoucle).toMatch(/(?:isolation|bwrap)[^.!?]*gate|gate[^.!?]*(?:isolation|bwrap)/i);
});
