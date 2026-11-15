import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import type { Server } from 'node:https';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { preparerMeshes } from './helpers-multi-mesh.js';
import { node } from './helpers.js';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { expect, test } from '@playwright/test';
import { appairerHost, demarrerHost, ORIGINE_APPAREIL } from './host-helpers.js';
import { fermerContextes } from './helpers.js';
import { NOM_E2E, ouvrirServeLocal } from './serve-local.js';

const PORT = Number(process.env.AID_E2E_PORT ?? 4871) + 14;
const FRONTAL = PORT + 30;
const FRONTAL_RELAIS = PORT + 31;
const RELAIS = 'https://example.com';
const CLI = join(import.meta.dirname, '../dist/cli/aid.js');
test.use({
  launchOptions: {
    args: [
      `--host-resolver-rules=MAP ${NOM_E2E}:443 127.0.0.1:${FRONTAL}, MAP example.com:443 127.0.0.1:${FRONTAL_RELAIS}`,
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

test('deux meshes : DM de même id, réponse confirmée sur perso et boards séparés', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const faux = await preparerMeshes();
  const precharge = join(faux.dossier, 'pda-fetch.mjs');
  writeFileSync(
    precharge,
    readFileSync(join(import.meta.dirname, 'pda-fetch.mjs'), 'utf8').replace(
      /const origine = '[^']+';/,
      `const origine = '${RELAIS}';`,
    ),
  );
  let home = '';
  let frontal: Server | undefined;
  let frontalRelais: Server | undefined;
  let relais: ChildProcess | undefined;
  let base: Database.Database | undefined;
  const portRelais = await portLibre();
  try {
    const ancien = process.env.NODE_OPTIONS;
    const ancienPort = process.env.AID_E2E_RELAIS_PORT;
    let instance: ReturnType<typeof demarrerHost>;
    try {
      process.env.NODE_OPTIONS = `${ancien ?? ''} --import ${pathToFileURL(precharge).href}`;
      process.env.AID_E2E_RELAIS_PORT = String(portRelais);
      instance = demarrerHost(PORT, faux.supplement);
      home = instance.home;
    } finally {
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
    await enregistrer('PDA recette');
    const origine = `http://127.0.0.1:${PORT}`;
    await mac.goto(`${origine}/boite`);
    const messages = mac.locator('[data-node^="1-2.mesh.dm-"][data-node$=".contenu"]');
    await expect(messages).toHaveCount(2);
    await expect(messages).toHaveText([
      'donnée d’un pair du meshMême id, deux messages.',
      'donnée d’un pair du meshMême id, deux messages.',
    ]);
    const pastilles = mac.locator('[data-node^="1-2.mesh.dm-"][data-node$=".source"]');
    await expect
      .poll(async () => (await pastilles.allTextContents()).sort())
      .toEqual(['perso', 'principal']);
    expect(base.prepare('SELECT mesh, id FROM mesh_inbox ORDER BY mesh').all()).toEqual([
      { mesh: 'perso', id: 46 },
      { mesh: 'principal', id: 46 },
    ]);
    const dmPerso = mac.locator('.element').filter({
      has: mac.locator('[data-node$=".source"]', { hasText: 'perso' }),
    });
    await dmPerso.getByRole('button', { name: 'Répondre (à blanc)' }).click();
    const formulaire = mac.getByRole('dialog');
    await expect(formulaire.getByLabel('Pair', { exact: true })).toHaveValue('peer-b');
    await formulaire.getByLabel('Texte', { exact: true }).fill('Réponse sur perso seulement.');
    await formulaire.getByRole('button', { name: "Voir l'aperçu" }).click();
    await expect(formulaire.getByRole('region', { name: 'Aperçu' })).toContainText('peer-b');
    await expect(formulaire.getByRole('region', { name: 'Aperçu' })).toContainText('Mesh : perso');
    const retour = mac.waitForResponse(
      (r) => r.url().includes('/api/swarph/ecrire/envoyer') && r.request().method() === 'POST',
    );
    await formulaire.getByRole('button', { name: 'Envoyer', exact: true }).click();
    expect((await retour).status()).toBe(202);
    const envois = () => faux.meshes.map((m) => m.requetes.filter((r) => r.verb === 'mesh.send'));
    expect(envois()).toEqual([[], []]);
    await telephone.goto(`${ORIGINE_APPAREIL}/pda`);
    await telephone.getByRole('button', { name: 'Actualiser' }).click();
    await expect(telephone.getByText('Mesh : perso', { exact: true })).toBeVisible();
    await expect(telephone.getByText(/— cell peer-a/)).toBeVisible();
    const numeroMac = mac.locator('strong').filter({ hasText: /^\d{4}$/ });
    await expect(numeroMac).toBeVisible();
    await telephone.getByLabel(/^Retape le numéro/).fill((await numeroMac.textContent())!);
    await telephone.getByRole('button', { name: 'Confirmer', exact: true }).click();
    await expect.poll(() => envois()[1]!.length, { timeout: 30_000 }).toBe(1);
    expect(envois()[0]).toEqual([]);
    expect(envois()[1]![0]!.args).toMatchObject({
      to_node: 'peer-b',
      content: 'Réponse sur perso seulement.',
    });
    await mac.goto(`${origine}/board`);
    await expect(mac.getByLabel('Mesh', { exact: true })).toHaveValue('principal');
    await expect(node(mac, 'board.carte-101')).toContainText('Carte principal');
    await mac.getByLabel('Mesh', { exact: true }).selectOption('perso');
    await expect(node(mac, 'board.carte-101')).toContainText('Carte perso');
    await mac.getByLabel('Mesh', { exact: true }).selectOption('principal');
    await expect(node(mac, 'board.carte-101')).toContainText('Carte principal');
    expect(envois().map((e) => e.length)).toEqual([0, 1]);
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
    await faux.fermer();
    expect(nettoyages.filter((n) => n.status === 'rejected')).toEqual([]);
  }
});

test('un seul mesh : aucune pastille de nom, aucun filtre ni sélecteur nouveau', async ({
  browser,
}) => {
  const faux = await preparerMeshes(['principal']);
  let home = '';
  const contexte = await browser.newContext();
  try {
    const instance = demarrerHost(PORT, faux.supplement);
    home = instance.home;
    const page = await contexte.newPage();
    const origine = `http://127.0.0.1:${PORT}`;
    await page.goto(`${origine}/?token=${instance.token}`);
    await page.goto(`${origine}/boite`);
    await expect(page.locator('[data-node$=".contenu"] pre')).toHaveText('Même id, deux messages.');
    await expect(page.locator('[data-node^="1-2.mesh.dm-"][data-node$=".source"]')).toHaveText(
      'mesh',
    );
    await expect(page.getByText('Filtrer par mesh', { exact: true })).toHaveCount(0);
    await expect(page.locator('[data-node$=".barre.mesh.texte"]')).not.toContainText('principal');
    await page.goto(`${origine}/board`);
    await expect(node(page, 'board.carte-101')).toContainText('Carte principal');
    await expect(page.getByLabel('Mesh', { exact: true })).toHaveCount(0);
  } finally {
    await contexte.close();
    if (home)
      execFileSync(process.execPath, [CLI, 'stop', '--force'], {
        env: { ...process.env, AID_HOME: home },
        timeout: 30_000,
      });
    await faux.fermer();
  }
});
