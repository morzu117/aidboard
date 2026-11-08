import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import type { Server } from 'node:https';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { expect, test } from '@playwright/test';
import { appairerHost, demarrerHost, ORIGINE_APPAREIL } from './host-helpers.js';
import { createTopic, fermerContextes, newRepo, node, registerWorkspace } from './helpers.js';
import { NOM_E2E, ouvrirServeLocal } from './serve-local.js';

const PORT = Number(process.env.AID_E2E_PORT ?? 4871) + 7;
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

test('Confirmations : merge, péremption, numéro, annulation, réglage et armement', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  let home = '';
  let frontal: Server | undefined;
  let frontalRelais: Server | undefined;
  let relais: ChildProcess | undefined;
  let base: Database.Database | undefined;
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
      instance = demarrerHost(PORT);
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
    const macUrl = `http://127.0.0.1:${PORT}`;
    await mac.context().addInitScript(() => localStorage.setItem('aid-e2e', '1'));
    await mac.goto(macUrl);
    await registerWorkspace(mac, newRepo('confirmations'));
    const sujet = await createTopic(mac, 'Confirmations e2e');
    const ligne = base.prepare('SELECT worktree FROM topics WHERE id = ?').get(sujet) as {
      worktree: string;
    };
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: ligne.worktree, encoding: 'utf8' }).trim();
    const avancerTete = () => {
      git(
        '-c',
        'user.name=e2e',
        '-c',
        'user.email=e2e@example.com',
        'commit',
        '--allow-empty',
        '-qm',
        'Avancer',
      );
      git('push', '-q', 'origin', 'HEAD');
    };
    avancerTete();
    base.prepare('UPDATE topics SET pr_number = 7 WHERE id = ?').run(sujet);
    const livraison = () => mac.goto(`${macUrl}/sujets/${sujet}/livraison`);
    const demanderMerge = async () => {
      await livraison();
      await node(mac, 'livraison.autoriser').click();
      const retour = mac.waitForResponse(
        (r) => r.url().endsWith('/actions/topic.merge') && r.request().method() === 'POST',
      );
      await node(mac, 'livraison.confirmer-merge.valider').click();
      return retour;
    };
    // Avant l'armement, le script part directement.
    const direct = await demanderMerge();
    expect(direct.status()).toBe(202);
    expect(await direct.json()).not.toHaveProperty('confirmation');
    await expect(node(mac, 'livraison.tuile-autorisation.valeur')).toHaveText('Fusionnée');
    base.prepare("UPDATE topics SET state = 'active' WHERE id = ?").run(sujet);
    await mac.goto(`${macUrl}/machines`);
    await enregistrer('PDA premier');
    await expect(mac.getByText(/Premier appareil activé sans confirmation/)).toBeVisible();
    await expect(mac.getByText(/Confirmations armées depuis/)).toBeVisible();

    const repondre = async (numero?: string) => {
      await telephone.goto(`${ORIGINE_APPAREIL}/pda`);
      await telephone.getByRole('button', { name: 'Actualiser' }).click();
      const saisie = telephone.getByLabel(/^Retape le numéro/);
      await expect(saisie).toBeVisible();
      await saisie.fill(numero ?? (await telephone.locator('.pda-numero').textContent())!);
      await telephone.getByRole('button', { name: 'Confirmer', exact: true }).click();
    };
    expect((await demanderMerge()).status()).toBe(202);
    await expect(mac.getByText('En attente de confirmation sur le téléphone')).toBeVisible();
    await expect(telephone.getByRole('heading', { name: /Merge de/ })).toHaveCount(0);
    await repondre();
    await expect(mac.getByText('Exécutée', { exact: true })).toBeVisible({ timeout: 30_000 });
    base.prepare("UPDATE topics SET state = 'active' WHERE id = ?").run(sujet);
    const perimee = await demanderMerge();
    expect(perimee.status()).toBe(202);
    avancerTete();
    await node(mac, 'livraison.relire').click();
    await expect(node(mac, 'livraison.titre')).toContainText(git('rev-parse', 'HEAD').slice(0, 7));
    await repondre();
    await expect(mac.getByText(/Périmée :/)).toBeVisible({ timeout: 30_000 });
    expect((await demanderMerge()).status()).toBe(202);
    await mac.getByRole('button', { name: 'Annuler', exact: true }).click();
    await expect(mac.getByText('Annulée', { exact: true })).toBeVisible();
    expect(base.prepare("SELECT id FROM pda_demandes WHERE etat = 'ouverte'").all()).toHaveLength(
      0,
    );

    const panneau = mac.getByRole('region', { name: 'Confirmations', exact: true });
    await mac.goto(`${macUrl}/machines`);
    await panneau.getByRole('switch', { name: 'Merge', exact: true }).click();
    const numeroMac = async () => {
      const numero = mac.locator('strong').filter({ hasText: /^\d{4}$/ });
      await expect(numero).toBeVisible();
      await expect(numero).toHaveCSS('font-size', '48px');
      return (await numero.textContent())!;
    };
    await repondre(await numeroMac());
    await expect(panneau.getByRole('switch', { name: 'Merge', exact: true })).not.toBeChecked({
      timeout: 30_000,
    });
    const rallumer = mac.waitForResponse(
      (r) => r.url().endsWith('/api/confirmations/reglage') && r.request().method() === 'PUT',
    );
    await panneau.getByRole('switch', { name: 'Merge', exact: true }).click();
    expect((await rallumer).status()).toBe(200);
    await expect(panneau.getByRole('switch', { name: 'Merge', exact: true })).toBeChecked();

    await panneau.getByRole('button', { name: 'Désarmer', exact: true }).click();
    await panneau.getByLabel('Tape DÉSARMER pour confirmer').fill('DÉSARMER');
    await panneau.getByRole('button', { name: 'Désarmer', exact: true }).click();
    await repondre(await numeroMac());
    await expect(panneau.getByText(/Confirmations désarmées le/)).toBeVisible({ timeout: 30_000 });
    const rearmer = mac.waitForResponse(
      (r) => r.url().endsWith('/api/confirmations/armer') && r.request().method() === 'POST',
    );
    await panneau.getByRole('button', { name: 'Réarmer' }).click();
    expect((await rearmer).status()).toBe(200);

    // Deux nouvelles réclamations ; le téléphone déjà actif signe leur approbation.
    for (const faux of [false, true]) {
      const creation = mac.waitForResponse(
        (r) => r.url().endsWith('/api/host/appairages') && r.request().method() === 'POST',
      );
      await node(mac, 'host.ajouter').click();
      const lien = (await (await creation).json()).url as string;
      const appareil = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
      await appareil.goto(lien);
      await node(appareil, 'appairer.nom').fill(faux ? 'Appareil refusé' : 'Appareil accepté');
      await node(appareil, 'appairer.demander').click();
      await expect(node(appareil, 'appairer.code-court')).toBeVisible();
      await node(mac, 'host.demande.approuver').click();
      const numero = await numeroMac();
      await repondre(faux ? (numero === '0000' ? '0001' : '0000') : numero);
      if (faux) {
        await expect(
          mac.getByText('Annulée : mauvais numéro saisi sur le téléphone', { exact: true }),
        ).toBeVisible({ timeout: 30_000 });
      } else {
        await expect(node(appareil, 'appareil.barre')).toBeVisible({ timeout: 30_000 });
      }
      await mac.reload();
    }
    mac.once('dialog', (d) => d.accept());
    await mac
      .getByRole('listitem')
      .filter({ hasText: 'PDA premier' })
      .getByRole('button', { name: 'Révoquer' })
      .click();
    const impossible = await demanderMerge();
    expect(impossible.status()).toBe(409);
    expect((await impossible.json()).error).toBe('confirmation_impossible');
    await expect(
      mac.getByText('Allume le PDA et active un téléphone pour cette action'),
    ).toBeVisible();
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
    expect(nettoyages.filter((n) => n.status === 'rejected')).toEqual([]);
  }
});
