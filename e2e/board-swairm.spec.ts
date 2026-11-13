import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { expect, test } from '@playwright/test';
import { node } from './helpers.js';

const cli = join(import.meta.dirname, '../dist/cli/aid.js');
const fixtures = join(import.meta.dirname, '../test/fixtures');
const date = '2026-11-10T10:00:00Z';

// Daemon et journaux séparés : aucun vrai CLI ni appel réseau.
test('board unifié : liens, copies, transition proposée et abandon sans écriture', async ({
  browser,
}) => {
  const dossier = realpathSync(mkdtempSync(join(tmpdir(), 'aid-e2e-board-swairm-')));
  const port = Number(process.env.AID_E2E_PORT ?? 4871) + 2;
  const base = `http://127.0.0.1:${port}`;
  const board = join(dossier, 'board');
  cpSync(join(fixtures, 'board'), board, { recursive: true });
  const lire = (nom: string) => JSON.parse(readFileSync(join(board, nom), 'utf8'));
  const sauver = (nom: string, valeur: unknown) =>
    writeFileSync(join(board, nom), JSON.stringify(valeur));
  const cartes = lire('cards-list-42.json');
  cartes.cards[0].body = 'Swairm: exemple/depot#41\nSwairm: exemple/depot#double';
  cartes.cards[1].body = 'Swairm: exemple/depot#double';
  sauver('cards-list-42.json', cartes);
  sauver('cards-search.json', { ...cartes, searched: 2 });
  sauver('cards-show-101.json', { ...lire('cards-show-101.json'), body: cartes.cards[0].body });
  const statut = (etat: string) => ({
    format: 'swairm-status/1',
    projets: [
      {
        projet: 'exemple/depot',
        sujets: [
          ['41', 'Un sujet', etat],
          ['double', 'Sujet en double', 'planned'],
          ['sans', 'Sujet sans carte', 'planned'],
          ['fini', 'Sujet déjà mergé', 'merged'],
          ['abandon', 'Sujet abandonné', 'abandoned'],
        ].map(([id, titre, etat]) => ({
          id,
          titre,
          etat,
          colonne: 'travail',
          en_pause: true,
          pas: { total: 3, par_etat: { done: 2, todo: 1 } },
          maj: date,
        })),
        vols: [{ cible: '41', machine: 'peer-a', pid: 12, depuis: date, tenant: 'test' }],
      },
    ],
    erreurs: [],
  });
  const etat = join(dossier, 'statut.json');
  writeFileSync(etat, JSON.stringify(statut('in_progress')));
  const swairm = join(dossier, 'swairm.mjs');
  const swarph = join(dossier, 'swarph.mjs');
  writeFileSync(
    swairm,
    `#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(dossier, 'swairm.log'))}, JSON.stringify(args) + '\\n');
if (JSON.stringify(args) !== JSON.stringify(['status', '--json'])) process.exit(2);
process.stdout.write(readFileSync(${JSON.stringify(etat)}));
`,
    { mode: 0o700 },
  );
  writeFileSync(
    swarph,
    `#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
// D327 : les réglages du faux CLI sont posés dans son script.
process.env.FAKE_SWARPH_BOARD = ${JSON.stringify(board)};
process.env.FAKE_SWARPH_LOG = ${JSON.stringify(join(dossier, 'swarph.log'))};
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(dossier, 'appels-swarph.jsonl'))}, JSON.stringify(args) + '\\n');
if (args.includes('--search')) {
  if (JSON.stringify(args) !== JSON.stringify(['board', 'cards', 'list', '--search', 'Swairm: ', '--json', '--as', 'peer-a'])) process.exit(2);
  process.stdout.write(readFileSync(${JSON.stringify(join(board, 'cards-search.json'))}));
} else {
  const r = spawnSync(${JSON.stringify(join(fixtures, 'fake-swarph.sh'))}, args, { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
`,
    { mode: 0o700 },
  );
  writeFileSync(
    join(dossier, 'config.yaml'),
    `port: ${port}
agents:
  transport: pty
swairm:
  bin: ${swairm}
mesh:
  bin: ${swarph}
  cell: peer-a
  cellFile: ${join(dossier, 'peer-a.yaml')}
  stateRoot: ${join(dossier, 'swarph_state')}
  gateway: https://example.com
  tailscale:
    manage: false
    bin: ${join(fixtures, 'fake-tailscale.sh')}
`,
    { mode: 0o600 },
  );
  const env = {
    ...process.env,
    AID_HOME: dossier,
    AID_NO_BROWSER: '1',
    SHELL: '/bin/sh',
    PATH: `${join(fixtures, 'bin')}${delimiter}${process.env.PATH}`,
    FAKE_TAILSCALE_STATEFILE: join(dossier, 'tailscale.state'),
  };
  const contexte = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  let demarre = false;
  try {
    execFileSync(process.execPath, [cli], { env, timeout: 40_000 });
    demarre = true;
    const { token } = JSON.parse(readFileSync(join(dossier, 'daemon.json'), 'utf8'));
    await contexte.addInitScript(() => localStorage.setItem('aid-e2e', '1'));
    const page = await contexte.newPage();
    const ecritures: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && new URL(r.url()).pathname.startsWith('/api/'))
        ecritures.push(new URL(r.url()).pathname);
    });
    await page.goto(`${base}/?token=${token}`);
    await node(page, '1-1.barre.nav-board').click();
    await expect(node(page, 'board.carte-101')).toContainText('Swairm · en cours');
    for (const id of [101, 102]) {
      await expect(node(page, `board.carte-${id}`)).toContainText(
        'Lien en double : cartes #101, #102.',
      );
    }
    const section = page.locator('details').filter({ hasText: 'Sujets Swairm sans carte' });
    const resume = section.locator('summary');
    await expect(resume).toHaveText('Sujets Swairm sans carte (1)');
    await expect(section).not.toHaveAttribute('open');
    await expect(section.getByRole('button', { name: 'Copier la ligne' })).toBeHidden();
    await resume.click();
    await expect(section).toHaveAttribute('open', '');
    await expect(section).toContainText('2 sujets merged ou abandoned sans carte non listés.');
    await expect(section.locator('li')).toHaveCount(1);
    await expect(section.locator('li')).toContainText('exemple/depot#sans · Sujet sans carte');
    await expect(section).not.toContainText('Sujet déjà mergé');
    await expect(section).not.toContainText('Sujet abandonné');
    await section.getByRole('button', { name: 'Copier la ligne', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe('Swairm: exemple/depot#sans');
    await section.getByRole('button', { name: 'Copier la commande', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(
        "swarph board cards create --project <PROJET> --title 'Sujet sans carte' --body 'Swairm: exemple/depot#sans'",
      );
    await node(page, 'board.carte-101').click();
    const bloc = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'Swairm', exact: true }) })
      .filter({ hasText: 'Swairm · en cours' });
    await expect(bloc).toContainText('Swairm · en cours');
    await expect(bloc.locator('dd')).toHaveText([
      'exemple/depot',
      '41',
      'travail',
      '3',
      '2',
      '1',
      date,
    ]);
    await expect(bloc).toContainText('en pause');
    await expect(bloc).toContainText(`Vol en cours : peer-a · depuis ${date}`);
    const [premieresPropositions] = await Promise.all([
      page.waitForResponse((r) => new URL(r.url()).pathname === '/api/swairm/propositions'),
      page.goto(`${base}/boite`),
    ]);
    expect(await premieresPropositions.json()).toEqual([]);
    await expect(
      page.getByRole('heading', { name: 'Proposer une note sur la carte #101' }),
    ).toHaveCount(0);
    writeFileSync(etat, JSON.stringify(statut('merged')));
    // Recharger le board déclenche sa lecture ; le cache réel du daemon dure 5 s.
    await expect(async () => {
      await page.goto(`${base}/board`);
      await expect(node(page, 'board.carte-101')).toContainText('Swairm · mergé', {
        timeout: 1000,
      });
    }).toPass({ timeout: 15_000, intervals: [1000] });
    await page.goto(`${base}/boite`);
    const proposition = page
      .locator('article')
      .filter({ has: page.getByRole('heading', { name: 'Proposer une note sur la carte #101' }) });
    await expect(proposition).toHaveCount(1);
    await proposition.getByRole('button', { name: 'Ouvrir', exact: true }).click();
    const dialogue = page.getByRole('dialog');
    await expect(dialogue.getByLabel('Texte', { exact: true })).toHaveValue(
      'Swairm : Un sujet — mergé.',
    );
    await expect(dialogue.getByLabel('Carte', { exact: true })).toHaveValue('101');
    await expect(dialogue.getByLabel('Kind', { exact: true })).toHaveValue('fyi');
    await dialogue.getByRole('button', { name: 'Fermer', exact: true }).click();
    await expect(proposition).toBeVisible();
    await proposition.getByRole('button', { name: 'Ignorer', exact: true }).click();
    await expect(proposition).toHaveCount(0);
    const [propositionsApresRechargement] = await Promise.all([
      page.waitForResponse((r) => new URL(r.url()).pathname === '/api/swairm/propositions'),
      page.reload(),
    ]);
    expect(await propositionsApresRechargement.json()).toEqual([]);
    await expect(
      page.getByRole('heading', { name: 'Proposer une note sur la carte #101' }),
    ).toHaveCount(0);
    expect(ecritures).toEqual([]);
    const appels = readFileSync(join(dossier, 'appels-swarph.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as string[]);
    expect(appels.filter((a) => a.includes('--search')).length).toBeGreaterThan(0);
    expect(
      appels
        .filter((a) => a[0] === 'board')
        .every((a) => ['list', 'show', 'graph', 'thread'].includes(a[2]!)),
    ).toBe(true);
    const lectures = readFileSync(join(dossier, 'swairm.log'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lectures.length).toBeGreaterThanOrEqual(2);
    expect(lectures.every((a) => JSON.stringify(a) === JSON.stringify(['status', '--json']))).toBe(
      true,
    );
  } finally {
    await contexte.close();
    if (demarre) execFileSync(process.execPath, [cli, 'stop', '--force'], { env, timeout: 30_000 });
    rmSync(dossier, { recursive: true, force: true });
  }
});
