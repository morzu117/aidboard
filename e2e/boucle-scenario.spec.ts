import { once } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { ServiceBoucle } from '../src/daemon/boucle/service.js';
import { commitFile, makeOriginAndClone, sh } from '../test/helpers/git.js';
import { capturerBoutons } from './captures-boutons.js';
import { createTopic, registerWorkspace } from './helpers.js';
import { expect, test as base, type Page } from './test.js';

const cli = join(import.meta.dirname, '../dist/cli/aid.js');
const faux = join(import.meta.dirname, '../test/fixtures/faux-agent-scenario-boucle.mjs');
const port = Number(process.env.AID_E2E_PORT ?? 4871) + 13;
const origine = `http://127.0.0.1:${port}`;

type Mode =
  'nominal' | 'sans-artefact' | 'gate-rouge' | 'revue-vide' | 'arret' | 'double-go' | 'redemarrage';
type Vue = ReturnType<ServiceBoucle['lire']>;
type Trace = { role: string; evenement: string; session: string };

const phase = (page: Page) => page.getByTestId('boucle-phase');
const ouvrir = (page: Page) => page.getByRole('button', { name: 'Boucle', exact: true }).click();

async function cliquer(page: Page, action: 'lancer' | 'go' | 'arreter') {
  const bouton = page.getByTestId(`boucle-${action}`);
  await expect(bouton).toBeEnabled();
  await bouton.click();
}

function pidVivant(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (erreur) {
    if ((erreur as NodeJS.ErrnoException).code !== 'ESRCH') throw erreur;
    return false;
  }
}

const test = base.extend<{
  mode: Mode;
  scenario: {
    page: Page;
    lire: () => Promise<Vue>;
    traces: (role: string, evenement: string) => Trace[];
    signaler: (nom: string) => void;
    gate: () => string[];
    processusAgents: () => string[];
    pids: () => number[];
    redemarrer: () => Promise<void>;
  };
}>({
  mode: ['nominal', { option: true }],
  scenario: async ({ browser, mode }, utiliser) => {
    const dossier = realpathSync(mkdtempSync(join(tmpdir(), 'aid-boucle-scenario-')));
    const env = {
      ...process.env,
      HOME: dossier,
      AID_HOME: dossier,
      TMPDIR: dossier,
      XDG_CONFIG_HOME: dossier,
      XDG_CACHE_HOME: dossier,
      AID_NO_BROWSER: '1',
      SHELL: '/bin/sh',
      PATH: [dossier, process.env.PATH].join(delimiter),
    };
    delete (env as NodeJS.ProcessEnv).AID_URL;
    delete (env as NodeJS.ProcessEnv).AID_TOKEN;
    const contexte = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await contexte.newPage();
    const info = join(dossier, 'daemon.json');
    const fichierPids = join(dossier, 'pids.json');
    const pids = () =>
      existsSync(fichierPids) ? (JSON.parse(readFileSync(fichierPids, 'utf8')) as number[]) : [];
    const lignes = (nom: string) => {
      const chemin = join(dossier, nom);
      return existsSync(chemin) ? readFileSync(chemin, 'utf8').trim().split('\n') : [];
    };
    let daemon: ChildProcess | undefined;

    async function demarrer() {
      daemon = spawn(process.execPath, [cli, 'daemon'], { env, stdio: 'ignore' });
      await expect
        .poll(() => existsSync(info) && JSON.parse(readFileSync(info, 'utf8')).pid)
        .toBe(daemon.pid);
      const { token } = JSON.parse(readFileSync(info, 'utf8')) as { token: string };
      await page.goto(`${origine}/?token=${encodeURIComponent(token)}`);
    }

    async function arreter() {
      if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
        const sorti = once(daemon, 'exit');
        daemon.kill('SIGTERM');
        await sorti;
      }
    }

    try {
      writeFileSync(join(dossier, 'scenario'), mode);
      const scriptAgent = join(dossier, 'agent.mjs');
      copyFileSync(faux, scriptAgent);
      writeFileSync(
        join(dossier, 'config.yaml'),
        `port: ${port}\nagents:\n  transport: stream\nmemory:\n  embeddings:\n    provider: off\nstructural:\n  engine: off\n`,
      );
      for (const fournisseur of ['claude', 'codex']) {
        writeFileSync(
          join(dossier, fournisseur),
          `#!/bin/sh\nexec "${process.execPath}" "${scriptAgent}" "${dossier}" "${fournisseur}" "$@"\n`,
          { mode: 0o700 },
        );
      }
      const { clone: depot } = makeOriginAndClone(dossier, { name: 'depot-scenario-fictif' });
      commitFile(
        depot,
        'gate.sh',
        [
          'set -eu',
          'git rev-parse HEAD >> "$HOME/tetes-gate"',
          ...(mode === 'nominal' ? ['while [ ! -f "$HOME/fin-gate" ]; do sleep 0.05; done'] : []),
          ...(mode === 'gate-rouge' ? ['exit 1'] : ['node --test test/note.test.cjs']),
        ].join('\n') + '\n',
      );
      commitFile(
        depot,
        'agent.yml',
        [
          'project: { namespace: aid }',
          'phases: [plan, acceptation, dev, review]',
          'capabilities: { dev_agent: claude, review_agent: codex }',
          'guardrails: { redev_cap: 1 }',
          'gates: { gate: "sh gate.sh" }',
          'acceptation:',
          '  chemins: [test/]',
          '  lancer:',
          '    test/: "node --test {fichiers}"',
        ].join('\n') + '\n',
      );
      sh(depot, 'push', '-q', 'origin', 'HEAD');
      await demarrer();
      await registerWorkspace(page, depot);
      const sujet = await createTopic(page, 'Sujet scénario fictif');
      const url = `${origine}/api/topics/${sujet}/boucle`;
      await ouvrir(page);
      await cliquer(page, 'lancer');
      await expect(phase(page)).toHaveText('En attente du GO');
      await expect(page.getByText(/Écrire la note et vérifier son contenu/)).toBeVisible();
      await utiliser({
        page,
        lire: async () => {
          const reponse = await page.request.get(url, { headers: { 'x-aid-cockpit': '1' } });
          expect(reponse.ok()).toBe(true);
          return reponse.json() as Promise<Vue>;
        },
        traces: (role, evenement) =>
          lignes('agents.jsonl')
            .map((ligne) => JSON.parse(ligne) as Trace)
            .filter((trace) => trace.role === role && trace.evenement === evenement),
        signaler: (nom) => writeFileSync(join(dossier, nom), ''),
        gate: () => lignes('tetes-gate'),
        processusAgents: () => lignes('processus-agents'),
        pids,
        redemarrer: async () => {
          const urlSujet = page.url();
          await arreter();
          await demarrer();
          await page.goto(urlSujet);
          await ouvrir(page);
        },
      });
    } finally {
      try {
        await contexte.close();
      } finally {
        await arreter();
        for (const pid of pids().reverse()) if (pidVivant(pid)) process.kill(pid, 'SIGKILL');
        rmSync(dossier, { recursive: true, force: true });
      }
    }
  },
});

test('du plan à la livraison prête, avec historique et mesures', async ({ scenario }) => {
  const { page, signaler, lire, gate } = scenario;
  await capturerBoutons(page, 'scenario-plan-go', page.getByTestId('boucle-go'));
  await cliquer(page, 'go');
  const etapes = [
    ['acceptation', 'Acceptation'],
    ['dev', 'Dev'],
    ['gate', 'Gate'],
    ['revue', 'Revue'],
  ] as const;
  for (const [etape, libelle] of etapes) {
    await expect(phase(page)).toHaveText(libelle);
    await capturerBoutons(page, `scenario-${etape}`, phase(page));
    if (etape !== 'revue') signaler(`fin-${etape}`);
  }
  const historique = page.getByTestId('boucle-historique');
  const triage = phase(page)
    .filter({ hasText: /^Triage$/ })
    .or(historique.getByText(/^Triage/));
  const observationTriage = expect(triage).toBeVisible();
  // La revue est encore en cours quand l'observation de la vue commence.
  const verdictTriage = observationTriage.catch((erreur: unknown) => erreur);
  signaler('fin-revue');
  await expect(phase(page)).toHaveText('Livraison prête');
  const vue = await lire();
  expect(vue.phase).toBe('livraison_prete');
  const etapesAgentsEtGate = ['plan', ...etapes.map(([etape]) => etape)];
  const tentatives = vue.historique.filter(({ type }) => etapesAgentsEtGate.includes(type));
  expect(tentatives.map(({ type, issue }) => [type, issue])).toEqual([
    ['plan', 'pass'],
    ['acceptation', 'pass'],
    ['dev', 'pass'],
    ['gate', 'pass'],
    ['revue', 'pass'],
  ]);
  const acteurs = vue.historique.flatMap(({ acteur }) => (acteur ? [acteur] : []));
  expect(acteurs.map(({ genre }) => genre)).toEqual(['claude', 'claude', 'claude', 'codex']);
  expect(new Set(acteurs.map(({ sessionId }) => sessionId)).size).toBe(4);
  expect(gate()).toEqual([vue.historique.find(({ type }) => type === 'dev')?.teteArrivee]);
  const mesures = page.locator('dl.sujet-boucle-mesures');
  expect(vue.mesures).toMatchObject({ interventionsHumaines: 1, redevs: 0 });
  await expect(
    mesures
      .locator('dt')
      .filter({ hasText: /^Interventions humaines$/ })
      .locator('+ dd'),
  ).toHaveText('1');
  await expect(
    mesures
      .locator('dt')
      .filter({ hasText: /^Re-dev$/ })
      .locator('+ dd'),
  ).toHaveText('0');
  for (const [etape, libelle] of [['plan', 'Plan'], ...etapes] as const) {
    const duree = vue.mesures.tempsParEtapeMs[etape];
    expect(duree).toBeGreaterThan(0);
    const essais = tentatives.filter(({ type }) => type === etape);
    expect(duree).toBe(essais.reduce((total, { fin, debut }) => total + fin! - debut, 0));
    await expect(
      historique.getByText(`${libelle} · tentative 1 · pass`, { exact: false }),
    ).toBeVisible();
    await expect(mesures.getByText(libelle, { exact: true }).locator('+ dd')).toHaveText(
      `${duree} ms`,
    );
  }
  await capturerBoutons(page, 'scenario-livraison', mesures);
  const echecTriage = await verdictTriage;
  if (echecTriage) throw echecTriage;
});

for (const [mode, role, raison] of [
  ['sans-artefact', 'dev', 'ambiguity'],
  ['revue-vide', 'review', 'ambiguity'],
] as const) {
  test.describe(mode, () => {
    test.use({ mode });
    test('relance la même session une fois et affiche l’escalade', async ({ scenario }) => {
      const { page, lire, traces } = scenario;
      await cliquer(page, 'go');
      await expect(phase(page)).toHaveText('Escalade');
      await capturerBoutons(page, `scenario-${mode}`, phase(page));
      await expect(page.getByText(raison, { exact: true })).toBeVisible();
      expect((await lire()).escalade?.raison).toBe(raison);
      const lancements = traces(role, 'lancement');
      expect(lancements).toHaveLength(1);
      expect(traces(role, 'tour').map(({ session }) => session)).toEqual([
        lancements[0]!.session,
        lancements[0]!.session,
      ]);
    });
  });
}

test.describe('gate rouge', () => {
  test.use({ mode: 'gate-rouge' });
  test('fait un re-dev puis affiche redev_cap', async ({ scenario }) => {
    const { page, lire, gate, traces } = scenario;
    await cliquer(page, 'go');
    await expect(phase(page)).toHaveText('Escalade');
    await capturerBoutons(page, 'scenario-gate-rouge', phase(page));
    await expect(page.getByText('redev_cap', { exact: true })).toBeVisible();
    const vue = await lire();
    expect(vue.escalade?.raison).toBe('redev_cap');
    expect(vue.mesures.redevs).toBe(1);
    expect(traces('dev', 'lancement')).toHaveLength(2);
    const gates = vue.historique.filter(({ type }) => type === 'gate');
    expect(gates.map(({ issue, preuve }) => [issue, preuve?.codeSortie])).toEqual([
      ['fail', 1],
      ['fail', 1],
    ]);
    expect(gate()).toEqual(gates.map(({ teteDepart }) => teteDepart));
    expect(new Set(gate()).size).toBe(2);
  });
});

test.describe('arrêt', () => {
  test.use({ mode: 'arret' });
  test('Arrêter tue l’agent et son enfant', async ({ scenario }) => {
    const { page, pids, lire } = scenario;
    await cliquer(page, 'go');
    await expect(phase(page)).toHaveText('Dev');
    await expect.poll(pids).toHaveLength(2);
    const processus = pids();
    expect(processus.map(pidVivant)).toEqual([true, true]);
    await cliquer(page, 'arreter');
    await expect(phase(page)).toHaveText('Arrêtée');
    await capturerBoutons(page, 'scenario-arretee', phase(page));
    expect(await lire()).toMatchObject({ phase: 'arretee', mesures: { interventionsHumaines: 2 } });
    await expect.poll(() => processus.map(pidVivant)).toEqual([false, false]);
  });
});

test.describe('double GO', () => {
  test.use({ mode: 'double-go' });
  test('deux clics sur le même sujet donnent un succès et un refus visible', async ({
    scenario,
  }) => {
    const { page, lire, traces } = scenario;
    const autre = await page.context().newPage();
    await autre.goto(page.url());
    await ouvrir(autre);
    await expect(phase(autre)).toHaveText('En attente du GO');
    const attendreGo = (onglet: Page) =>
      onglet.waitForResponse(
        (reponse) =>
          new URL(reponse.url()).pathname.endsWith('/boucle/go') &&
          reponse.request().method() === 'POST',
      );
    const [premiere, seconde] = await Promise.all([
      attendreGo(page),
      attendreGo(autre),
      cliquer(page, 'go'),
      cliquer(autre, 'go'),
    ]);
    expect([premiere.status(), seconde.status()].sort()).toEqual([200, 409]);
    const refus = premiere.status() === 409 ? page : autre;
    const alerte = refus
      .getByRole('alert')
      .filter({ hasText: 'Commande indisponible pour cette boucle' });
    await expect(alerte).toBeVisible();
    await capturerBoutons(refus, 'scenario-double-go', alerte);
    expect(await lire()).toMatchObject({
      phase: 'acceptation',
      mesures: { interventionsHumaines: 1 },
    });
    await expect.poll(() => traces('acceptation', 'lancement')).toHaveLength(1);
  });
});

test.describe('redémarrage', () => {
  test.use({ mode: 'redemarrage' });
  test('reprend la tentative persistée sans relancer le dev', async ({ scenario }) => {
    const { page, lire, traces, pids, processusAgents, redemarrer } = scenario;
    await cliquer(page, 'go');
    await expect(phase(page)).toHaveText('Dev');
    await expect.poll(pids).toHaveLength(2);
    const avant = await lire();
    const lancements = traces('dev', 'lancement');
    expect(lancements).toHaveLength(1);
    const processusAvant = processusAgents();
    await redemarrer();
    await expect(phase(page)).toHaveText('Escalade');
    await expect(page.getByText('cannot_evaluate', { exact: true }).first()).toBeVisible();
    await capturerBoutons(page, 'scenario-reprise', phase(page));
    const apres = await lire();
    expect(apres.escalade?.raison).toBe('cannot_evaluate');
    expect(apres.historique.slice(0, -1)).toEqual(avant.historique);
    expect(apres.historique.at(-1)).toMatchObject({
      ...avant.etapeCourante,
      issue: 'cannot_evaluate',
    });
    expect(traces('dev', 'lancement')).toEqual(lancements);
    expect(processusAgents()).toEqual(processusAvant);
  });
});
