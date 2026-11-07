import { execFileSync } from 'node:child_process';
import { createECDH, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import type { Server } from 'node:https';
import { delimiter, join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, type Page, test } from '@playwright/test';
import { appairerHost, demarrerHost, ORIGINE_APPAREIL } from './host-helpers.js';
import { createTopic, fermerContextes, newRepo, node, registerWorkspace } from './helpers.js';
import { NOM_E2E, ouvrirServeLocal } from './serve-local.js';

const PORT = Number(process.env.AID_E2E_PORT ?? 4871) + 4;
const FRONTAL = PORT + 30;
const CLI = join(import.meta.dirname, '../dist/cli/aid.js');
test.use({
  viewport: { width: 390, height: 844 },
  launchOptions: {
    args: [
      `--host-resolver-rules=MAP ${NOM_E2E}:443 127.0.0.1:${FRONTAL}`,
      '--ignore-certificate-errors',
    ],
  },
});
let home = '';
let frontal: Server;
let mac: Page;
let telephone: Page;
let sujet = '';
let base: Database.Database;
const push = () => mac.getByRole('switch', { name: 'Notifications push' });
const code = () => mac.getByRole('switch', { name: 'Montrer le code' });
const notifications = () => telephone.goto(`${ORIGINE_APPAREIL}/notifications`);
async function etatHost() {
  return mac.evaluate(async () => (await fetch('/api/host')).json());
}

// Le CLI démarre un processus séparé : aucune injection de transport et aucune ouverture
// de la liste fermée. Le sous-domaine synthétique autorisé ne dessert aucun service push.
test.describe.serial('push et diff (32b.10), Chromium', () => {
  test.beforeAll(async ({ browser }) => {
    const instance = demarrerHost(
      PORT,
      'agents:\n  transport: stream',
      `${join(import.meta.dirname, '../test/fixtures/bin-stream')}${delimiter}${process.env.PATH}`,
    );
    home = instance.home;
    base = new Database(join(home, 'state.db'), { readonly: true });
    frontal = await ouvrirServeLocal({ dir: home, port: FRONTAL, versPort: PORT + 20 });
    const contexte = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await contexte.addInitScript(() => localStorage.setItem('aid-e2e', '1'));
    mac = await contexte.newPage();
    await mac.goto(`http://127.0.0.1:${PORT}/?token=${instance.token}`);
    await registerWorkspace(mac, newRepo('depot-push-diff'));
    sujet = await createTopic(mac, 'Push et diff');
    await node(mac, '1-3.vide.lancer-claude').click();
    await expect(node(mac, '1-3.conversation.composer.champ')).toBeVisible();
    const worktree = await mac.evaluate(async (id) => {
      const etat = (await (await fetch('/api/state')).json()) as {
        topics: Array<{ id: string; worktree: string }>;
      };
      return etat.topics.find((t) => t.id === id)!.worktree;
    }, sujet);
    writeFileSync(join(worktree, 'normal.txt'), 'bonjour\npassword: secret-factice-recette\n');
    writeFileSync(join(worktree, '.env'), 'EXEMPLE=valeur-factice\n');
    execFileSync('git', ['add', '--', 'normal.txt', '.env'], { cwd: worktree });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=e2e',
        '-c',
        'user.email=e2e@example.com',
        'commit',
        '-qm',
        'Diff de recette',
      ],
      { cwd: worktree },
    );
    telephone = await appairerHost(browser, mac, PORT, 'Push e2e', { width: 390, height: 844 });
    const paire = createECDH('prime256v1');
    const p256dh = paire.generateKeys().toString('base64url');
    const auth = randomBytes(16).toString('base64url');
    // Seul le PushManager du navigateur est simulé ; POST, stockage et déclencheur sont réels.
    await telephone.context().addInitScript(
      ({ p256dh, auth }) => {
        Object.defineProperty(Notification, 'requestPermission', { value: async () => 'granted' });
        Object.defineProperty(PushManager.prototype, 'subscribe', {
          value: async () => ({
            toJSON: () => ({
              endpoint: 'https://e2e.invalid.fcm.googleapis.com/fcm/send/e2e-recette',
              keys: { p256dh, auth },
            }),
          }),
        });
      },
      { p256dh, auth },
    );
  });
  test.afterAll(async ({ browser }) => {
    await fermerContextes(browser);
    base?.close();
    await new Promise<void>((resolve) => (frontal ? frontal.close(() => resolve()) : resolve()));
    if (home)
      execFileSync(process.execPath, [CLI, 'stop', '--force'], {
        env: { ...process.env, AID_HOME: home },
        timeout: 30_000,
      });
  });

  test('interrupteurs coupés par défaut, abonnement et question journalisée en échec', async () => {
    await expect(push()).not.toBeChecked();
    await expect(code()).not.toBeChecked();
    await notifications();
    await expect(telephone.getByText('Les notifications sont coupées sur le Mac.')).toBeVisible();
    await push().click();
    await expect(push()).toBeChecked();
    await notifications();
    await telephone.getByRole('button', { name: 'Activer les notifications', exact: true }).click();
    await expect(
      telephone.getByText('Les notifications sont actives sur ce téléphone'),
    ).toBeVisible();
    expect((await etatHost()).abonnements).toBe(1);
    expect(base.prepare('SELECT endpoint FROM push_abonnements').get()).toEqual({
      endpoint: 'https://e2e.invalid.fcm.googleapis.com/fcm/send/e2e-recette',
    });
    const abonnement = base.prepare('SELECT appareil_id FROM push_abonnements').get() as {
      appareil_id: string;
    };
    await mac.goto(`http://127.0.0.1:${PORT}/sujets/${sujet}`);
    const champ = node(mac, '1-3.conversation.composer.champ');
    await champ.fill('demande questions');
    await champ.press('Enter');
    await telephone.goto(ORIGINE_APPAREIL);
    await expect(telephone.getByText('(1/2) Où écrire le graphe ?', { exact: true })).toBeVisible();
    await expect
      .poll(() => base.prepare("SELECT data FROM events WHERE type = 'push.envoye'").all(), {
        timeout: 25_000,
      })
      .toEqual([{ data: JSON.stringify({ appareilId: abonnement.appareil_id, statut: 'echec' }) }]);
  });

  test('couper le push efface l’abonnement et informe le téléphone', async () => {
    await mac.goto(`http://127.0.0.1:${PORT}/machines`);
    mac.once('dialog', (dialogue) => dialogue.accept());
    await push().click();
    await expect(push()).not.toBeChecked();
    await notifications();
    await expect(telephone.getByText('Les notifications sont coupées sur le Mac.')).toBeVisible();
    expect((await etatHost()).abonnements).toBe(0);
    expect(base.prepare('SELECT count(*) AS n FROM push_abonnements').get()).toEqual({ n: 0 });
  });

  test('diff réel : secret masqué, .env refusé puis lecture coupée', async () => {
    await code().click();
    await expect(code()).toBeChecked();
    const livraison = (await telephone.evaluate(
      async (id) => (await fetch(`/api/appareils/sujets/${id}/livraison`)).json(),
      sujet,
    )) as { fichiers: { nom: string }[] };
    const normal = livraison.fichiers.findIndex((f) => f.nom === 'normal.txt');
    const sensible = livraison.fichiers.findIndex((f) => f.nom === '.env');
    expect(normal).toBeGreaterThanOrEqual(0);
    expect(sensible).toBeGreaterThanOrEqual(0);
    const chemin = `${ORIGINE_APPAREIL}/sujets/${sujet}/fichiers/`;
    await telephone.goto(`${chemin}${normal}`);
    await expect(telephone.locator('.appareil-diff')).toContainText('+bonjour');
    await expect(telephone.locator('.appareil-diff')).toContainText('password: [masqué]');
    await expect(telephone.locator('main')).not.toContainText('secret-factice-recette');
    await telephone.goto(`${chemin}${sensible}`);
    await expect(telephone.getByText('Fichier sensible : il se lit sur le Mac.')).toBeVisible();
    await code().click();
    await expect(code()).not.toBeChecked();
    await telephone.goto(`${chemin}${normal}`);
    await expect(telephone.getByText('La lecture du code est coupée sur le Mac.')).toBeVisible();
  });

  test('révocation : aucun abonnement actif', async () => {
    await push().click();
    await expect(push()).toBeChecked();
    await notifications();
    await telephone.getByRole('button', { name: 'Activer les notifications', exact: true }).click();
    await expect(
      telephone.getByText('Les notifications sont actives sur ce téléphone'),
    ).toBeVisible();
    expect((await etatHost()).abonnements).toBe(1);
    await mac
      .locator('[data-node^="host.appareil."]', { hasText: 'Push e2e' })
      .locator('[data-node$=".revoquer"]')
      .click();
    await expect(node(telephone, 'appareil.hors-acces.phrase')).toContainText('Accès coupé');
    expect((await etatHost()).abonnements).toBe(0);
    expect(base.prepare('SELECT count(*) AS n FROM push_abonnements').get()).toEqual({ n: 0 });
  });
});
