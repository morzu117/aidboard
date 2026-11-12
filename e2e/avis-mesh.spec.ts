import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import type { Server } from 'node:https';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect, test } from '@playwright/test';
import { appairerHost, demarrerHost, ORIGINE_APPAREIL } from './host-helpers.js';
import { fermerContextes, node } from './helpers.js';
import { NOM_E2E, ouvrirServeLocal } from './serve-local.js';

const PORT = Number(process.env.AID_E2E_PORT ?? 4871) + 12;
const FRONTAL = PORT + 30;
const FRONTAL_RELAIS = PORT + 31;
const RELAIS = 'https://relais.aid-e2e.example';
const CLI = join(import.meta.dirname, '../dist/cli/aid.js');
test.use({
  launchOptions: {
    args: [
      `--host-resolver-rules=MAP ${NOM_E2E}:443 127.0.0.1:${FRONTAL}, MAP relais.aid-e2e.example:443 127.0.0.1:${FRONTAL_RELAIS}`,
      '--ignore-certificate-errors',
      '--no-proxy-server',
    ],
  },
});

async function portLibre() {
  const serveur = createServer();
  await new Promise<void>((resolve) => serveur.listen(0, '127.0.0.1', resolve));
  const port = (serveur.address() as { port: number }).port;
  await new Promise<void>((resolve) => serveur.close(() => resolve()));
  return port;
}
async function fermer(serveur?: Server) {
  if (!serveur) return;
  serveur.closeAllConnections();
  await new Promise<void>((resolve) => serveur.close(() => resolve()));
}
async function arreter(relais?: ChildProcess) {
  if (!relais || relais.exitCode !== null) return;
  const fin = once(relais, 'exit');
  relais.kill('SIGTERM');
  await fin;
}

test('avis mesh : confirmation, scellé et relecture sur un faux swarph', async ({ browser }) => {
  test.setTimeout(180_000);
  let home = '';
  let frontal: Server | undefined;
  let frontalRelais: Server | undefined;
  let relais: ChildProcess | undefined;
  let base: Database.Database | undefined;
  const faux = mkdtempSync(join(tmpdir(), 'aid-avis-faux-'));
  const fixtures = join(import.meta.dirname, '../test/fixtures');
  const journal = join(faux, 'appels.jsonl');
  const appels = (): { args: string[]; sieges?: unknown; charter?: string }[] => {
    try {
      return readFileSync(journal, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  writeFileSync(
    join(faux, 'swarph'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');
const racine = __dirname;
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('0.75.0'); process.exit(0); }
if (args[0] === 'mesh' && args[1] === 'peers') { console.log('peer-a 0.75.0\\npeer-b 0.75.0\\npeer-c 0.75.0\\npeer-d 0.75.0'); process.exit(0); }
if (args[0] === 'monitor') {
 const marque = path.join(racine, 'monitor');
 if (args[1] === 'start') { fs.writeFileSync(marque, 'actif'); process.exit(0); }
 if (args[1] === 'stop') { fs.rmSync(marque, {force:true}); process.exit(0); }
 const actif = fs.existsSync(marque);
 console.log(JSON.stringify({running:actif,pid:actif ? 4242 : null,pidfile_status:actif ? 'alive' : 'missing',observation_cursor:0,sinks:[],state_dir:racine}));
 process.exit(actif ? 0 : 1);
}
if (args[0] !== 'committee') {
 const r = cp.spawnSync(${JSON.stringify(join(fixtures, 'fake-swarph.sh'))}, args, {encoding:'utf8', env:{...process.env, FAKE_SWARPH_BOARD:${JSON.stringify(join(fixtures, 'board'))}}});
 process.stdout.write(r.stdout || ''); process.stderr.write(r.stderr || ''); process.exit(r.status ?? 1);
}
if (args[args.length-2] !== '--as' || args[args.length-1] !== 'peer-c') process.exit(9);
const appel = {args};
if (args.includes('--charter-file')) appel.charter = fs.readFileSync(args[args.indexOf('--charter-file')+1], 'utf8');
if (args.includes('--seats-file')) appel.sieges = JSON.parse(fs.readFileSync(args[args.indexOf('--seats-file')+1], 'utf8'));
fs.appendFileSync(path.join(racine, 'appels.jsonl'), JSON.stringify(appel)+'\\n');
if (args[1] === 'rooms') console.log(JSON.stringify({channel:'avis-test'}));
else if (args.includes('--open')) console.log(JSON.stringify({id:42}));
else if (args[1] === 'results') process.stdout.write(fs.readFileSync(path.join(racine, 'resultats.json')));
else process.exit(8);
`,
    { mode: 0o700 },
  );
  writeFileSync(
    join(faux, 'resultats.json'),
    JSON.stringify({
      channel: 'avis-test',
      card_id: 1,
      baseline_absent: null,
      positions_absent: [],
      id: 42,
      text: 'Question',
      options: ['avis', 'objection'],
      phase: 'positions',
      positions_deadline: new Date(Date.now() + 86400000).toISOString(),
      rebuttal_deadline: new Date(Date.now() + 90000000).toISOString(),
      vote_deadline: new Date(Date.now() + 93600000).toISOString(),
      seats: [
        { peer: 'peer-c', role: 'chair', family: 'orchestrator', voided: false, recast_from: null },
        { peer: 'peer-d', role: 'baseline', family: 'claude', voided: false, recast_from: null },
        { peer: 'peer-a', role: 'seat', family: 'gemini', voided: false, recast_from: null },
        { peer: 'peer-b', role: 'seat', family: 'gpt', voided: false, recast_from: null },
      ],
      ballots: ['peer-a', 'peer-b'].map((peer, i) => ({
        peer,
        round: 'positions',
        created_at: new Date().toISOString(),
        voided: false,
        placeholder: 'exemple',
        message_id: i + 1,
      })),
    }),
  );
  const portRelais = await portLibre();
  try {
    const ancienGh = process.env.AID_GH_BIN;
    process.env.AID_GH_BIN = join(import.meta.dirname, '../test/fixtures/fake-gh.sh');
    const ancien = process.env.NODE_OPTIONS;
    const ancienPort = process.env.AID_E2E_RELAIS_PORT;
    let instance: ReturnType<typeof demarrerHost>;
    try {
      process.env.NODE_OPTIONS = `${ancien ?? ''} --import ${pathToFileURL(join(import.meta.dirname, 'pda-fetch.mjs')).href}`;
      process.env.AID_E2E_RELAIS_PORT = String(portRelais);
      instance = demarrerHost(
        PORT,
        `  bin: ${join(faux, 'swarph')}
  cell: peer-c
  gateway: https://example.com
  avis:
    baseline: peer-d
    familles:
      peer-d: claude
      peer-a: gemini
      peer-b: gpt
swairm:
  bin: ${join(fixtures, 'fake-swairm.sh')}`,
        `${faux}:${join(fixtures, 'bin')}:${process.env.PATH}`,
      );
      home = instance.home;
    } finally {
      if (ancienGh === undefined) delete process.env.AID_GH_BIN;
      else process.env.AID_GH_BIN = ancienGh;
      if (ancien === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = ancien;
      if (ancienPort === undefined) delete process.env.AID_E2E_RELAIS_PORT;
      else process.env.AID_E2E_RELAIS_PORT = ancienPort;
    }
    base = new Database(join(home, 'state.db'));
    frontal = await ouvrirServeLocal({ dir: home, port: FRONTAL, versPort: PORT + 20 });
    frontalRelais = await ouvrirServeLocal({
      dir: home,
      port: FRONTAL_RELAIS,
      versPort: portRelais,
    });
    const mac = await (await browser.newContext()).newPage();
    await mac.goto(`http://127.0.0.1:${PORT}/?token=${instance.token}`);
    await mac.goto(`http://127.0.0.1:${PORT}/machines`);
    const lancerRelais = async () => {
      const cle = await mac.evaluate(
        async () => (await (await fetch('/api/host/pda/cle')).json()).clePublique as string,
      );
      relais = spawn(
        process.execPath,
        [
          CLI,
          'relais',
          '--hote',
          '127.0.0.1',
          '--port',
          String(portRelais),
          '--origine',
          ORIGINE_APPAREIL,
          '--cle-daemon',
          cle,
        ],
        { stdio: 'ignore' },
      );
      await expect
        .poll(async () => {
          try {
            return (await fetch(`http://127.0.0.1:${portRelais}/`)).status;
          } catch {
            return 0;
          }
        })
        .toBe(404);
    };
    await lancerRelais();
    await mac.getByLabel('Adresse du relais').fill(RELAIS);
    mac.once('dialog', (d) => d.accept());
    await mac.getByRole('switch', { name: 'PDA :' }).click();
    await expect(mac.getByRole('switch', { name: 'PDA :' })).toBeChecked();
    const telephone = await appairerHost(browser, mac, PORT, 'Téléphone PDA');
    const cdp = await telephone.context().newCDPSession(telephone);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
      },
    });
    const enregistrer = async (nom: string) => {
      await telephone.goto(`${ORIGINE_APPAREIL}/pda/enregistrer`);
      await telephone.getByLabel('Nom de cet appareil').fill(nom);
      await telephone
        .getByRole('button', { name: 'Enregistrer cet appareil', exact: true })
        .click();
      await expect(telephone.locator('.pda-empreinte')).toBeVisible();
      const empreinte = (await telephone.locator('.pda-empreinte').textContent())!;
      await mac.reload();
      const ligne = mac.getByRole('listitem').filter({ hasText: nom });
      await expect(ligne.locator('code')).toHaveText(empreinte);
      mac.once('dialog', async (d) => {
        expect(d.message()).toContain(empreinte);
        await d.accept();
      });
      await ligne.getByRole('button', { name: 'Activer', exact: true }).click();
      await expect(ligne.getByText('actif', { exact: true })).toBeVisible();
      await telephone.goto(`${ORIGINE_APPAREIL}/pda`);
    };
    await mac.goto(`http://127.0.0.1:${PORT}/reglages#mesh`);
    await node(mac, 'reglages.mesh.connecter').click();
    await expect(node(mac, 'reglages.mesh.etat')).toContainText('monitor actif');
    await mac.goto(`http://127.0.0.1:${PORT}/machines`);
    await enregistrer('PDA recette');
    await mac.goto(`http://127.0.0.1:${PORT}/swarph`);
    await node(mac, 'swarph.ask').click();
    const boite = mac.getByRole('dialog', { name: 'Demander N avis' });
    await boite.getByRole('button', { name: 'Au mesh', exact: true }).click();
    await boite.getByLabel('Question', { exact: true }).fill('1. Faut-il vérifier les tests ?');
    for (const cell of ['peer-a', 'peer-b'])
      await boite.getByRole('checkbox', { name: cell, exact: true }).check();
    await boite.getByLabel('Numéro de carte').fill('101');
    await boite.getByRole('button', { name: 'Confirmer la carte' }).click();
    for (const [tour, duree] of [
      ['positions', '24'],
      ['rebuttal', '1'],
      ['vote', '1'],
    ] as const)
      await expect(boite.getByLabel(`Durée ${tour} (heures)`)).toHaveValue(duree);
    await boite.getByRole('button', { name: 'Envoyer', exact: true }).click();
    const apercu = boite.getByRole('region', { name: 'Aperçu exact' });
    for (const texte of [
      'peer-c — chair — orchestrator',
      'peer-d — baseline — claude',
      'peer-a — seat — gemini',
      'peer-b — seat — gpt',
      'Carte 101',
      'positions :',
      'rebuttal :',
      'vote :',
      'Faut-il vérifier les tests ?',
    ])
      await expect(apercu).toContainText(texte);
    expect(appels()).toHaveLength(0);
    await telephone.goto(`${ORIGINE_APPAREIL}/pda`);
    await telephone.getByRole('button', { name: 'Actualiser' }).click();
    await telephone
      .getByLabel(/^Retape le numéro/)
      .fill((await boite.locator('strong').textContent())!);
    await telephone.getByRole('button', { name: 'Confirmer', exact: true }).click();
    await expect(boite.getByText('Exécutée', { exact: true })).toBeVisible({ timeout: 30000 });
    const ecritures = appels();
    expect(ecritures.map((a) => a.args.slice(0, 3))).toEqual([
      ['committee', 'rooms', 'open'],
      ['committee', 'motion', 'avis-test'],
    ]);
    expect(ecritures[0]!.sieges).toEqual([
      { peer: 'peer-c', role: 'chair', family: 'orchestrator' },
      { peer: 'peer-d', role: 'baseline', family: 'claude' },
      { peer: 'peer-a', role: 'seat', family: 'gemini' },
      { peer: 'peer-b', role: 'seat', family: 'gpt' },
    ]);
    const jeton = (await apercu.locator('pre').textContent())!.match(/<<<QUESTION-([a-f0-9]{8})/)!;
    expect(ecritures[0]!.charter).toContain(jeton[1]!);
    const salle = ecritures[0]!.args;
    expect(salle[salle.indexOf('--card-id') + 1]).toBe('101');
    expect(salle[salle.indexOf('--name') + 1]).toMatch(/^avis-/);
    const argv = ecritures[1]!.args;
    expect(argv).toContain('--open');
    expect(argv[argv.indexOf('--options') + 1]).toBe('avis,objection');
    const dates = ['positions', 'rebuttal', 'vote'].map((tour) =>
      Date.parse(argv[argv.indexOf(`--${tour}-deadline`) + 1]!),
    );
    expect(dates[1]! - dates[0]!).toBe(3600000);
    expect(dates[2]! - dates[1]!).toBe(3600000);
    expect(dates[0]! - Date.now()).toBeGreaterThan(23 * 3600000);
    await boite.getByRole('button', { name: 'Fermer', exact: true }).last().click();
    const liste = mac.getByRole('region', { name: 'Demandes au mesh' });
    await liste.getByRole('button', { name: 'Relire les demandes au mesh' }).click();
    await liste.getByRole('button', { name: /peer-a, peer-b/ }).click();
    const tableau = mac.getByRole('dialog', { name: 'Avis au mesh' });
    await expect(tableau).toContainText('Phase : positions');
    await expect(
      tableau.locator('tbody td').filter({ hasText: 'scellé par le gateway' }),
    ).toHaveCount(2);
    await expect(tableau).toContainText('pas encore posté');
    await expect(tableau.getByRole('button', { name: 'Déclarer le baseline absent' })).toHaveCount(
      0,
    );
    const resultats = JSON.parse(readFileSync(join(faux, 'resultats.json'), 'utf8'));
    resultats.phase = 'rebuttal';
    resultats.baseline_absent = {
      reason: 'échéance passée',
      by: 'peer-c',
      at: new Date().toISOString(),
    };
    resultats.ballots[0].body = JSON.stringify({
      reponses: [{ n: 1, verdict: 'oui', justification: 'Tests utiles.' }],
    });
    resultats.ballots[0].outcome = 'pass';
    resultats.ballots[1].body = 'Évaluation impossible';
    resultats.ballots[1].outcome = 'cannot_evaluate';
    writeFileSync(join(faux, 'resultats.json'), JSON.stringify(resultats));
    await tableau.getByRole('button', { name: 'Relire', exact: true }).click();
    await expect(tableau).toContainText('Phase : rebuttal');
    await expect(tableau.locator('tbody td')).toHaveText([
      'ouiJustificationTests utiles.',
      'abstention',
      '',
      'insuffisant',
    ]);
    await expect(tableau).toContainText('baseline déclaré absent');
    resultats.ballots.pop();
    resultats.positions_absent = ['peer-b'];
    writeFileSync(join(faux, 'resultats.json'), JSON.stringify(resultats));
    await tableau.getByRole('button', { name: 'Relire', exact: true }).click();
    await expect(tableau.locator('tbody td')).toHaveText([
      'ouiJustificationTests utiles.',
      'absent',
      '',
      'insuffisant',
    ]);
    resultats.phase = 'closed';
    resultats.ballots.push({
      peer: 'peer-a',
      round: 'vote',
      created_at: new Date().toISOString(),
      voided: false,
      placeholder: 'exemple',
      message_id: 3,
      body: 'avis',
      outcome: 'pass',
    });
    resultats.ballots.push({
      peer: 'peer-a',
      round: 'positions',
      created_at: new Date().toISOString(),
      voided: true,
      placeholder: 'exemple',
      message_id: 4,
      body: 'exemple annulé',
      outcome: 'pass',
    });
    resultats.seats.push({
      peer: 'ancien',
      role: 'seat',
      family: 'meta',
      voided: true,
      recast_from: 'peer-a',
    });
    writeFileSync(join(faux, 'resultats.json'), JSON.stringify(resultats));
    await tableau.getByRole('button', { name: 'Relire', exact: true }).click();
    await expect(tableau).toContainText('Vote : maintient');
    await expect(tableau.locator('tbody td')).toHaveText([
      'ouiJustificationTests utiles.',
      'absent',
      '',
      'insuffisant',
    ]);
    for (const appel of appels()) expect(appel.args.slice(-2)).toEqual(['--as', 'peer-c']);
  } finally {
    const nettoyages = await Promise.allSettled([
      fermerContextes(browser),
      arreter(relais),
      fermer(frontalRelais),
      fermer(frontal),
    ]);
    base?.close();
    if (home)
      execFileSync(process.execPath, [CLI, 'stop', '--force'], {
        env: { ...process.env, AID_HOME: home },
        timeout: 30_000,
      });
    rmSync(faux, { recursive: true, force: true });
    expect(nettoyages.filter((n) => n.status === 'rejected')).toEqual([]);
  }
});
