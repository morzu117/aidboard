import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import type { Server } from 'node:https';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { expect, test } from '@playwright/test';
import { appairerHost, demarrerHost, ORIGINE_APPAREIL } from './host-helpers.js';
import { fermerContextes } from './helpers.js';
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

test('Confirmations complètes : paramètres, résultat et numéro faux', async ({ browser }) => {
  test.setTimeout(180_000);
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
      process.env.NODE_OPTIONS = `${ancien ?? ''} --import ${pathToFileURL(join(import.meta.dirname, 'pda-fetch.mjs')).href}`;
      process.env.AID_E2E_RELAIS_PORT = String(portRelais);
      instance = demarrerHost(PORT);
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
    const panneau = mac.getByRole('region', { name: 'Confirmations', exact: true });
    // Les minuteries du téléphone avancent seules ; le daemon garde sa vraie cadence.
    await telephone.clock.install();
    await telephone.clock.pauseAt(new Date(Date.now() + 1_000));
    for (const faux of [false, true]) {
      const creation = mac.waitForResponse(
        (r) => r.url().endsWith('/api/confirmations/reglage') && r.request().method() === 'PUT',
      );
      await panneau.getByRole('switch', { name: 'Merge', exact: true }).click();
      const reponse = await creation;
      expect(reponse.status()).toBe(202);
      const { confirmation } = await reponse.json();
      const id = confirmation as string;
      const liste = await mac.evaluate(async () => {
        const retour = await fetch('/api/confirmations');
        return { cache: retour.headers.get('cache-control'), corps: await retour.json() };
      });
      expect(liste.cache).toBe('no-store');
      for (const demande of [...liste.corps.ouvertes, ...liste.corps.recentes]) {
        expect(demande).not.toHaveProperty('numero');
        expect(demande).not.toHaveProperty('numero_mac');
      }
      expect(liste.corps.ouvertes.find((d: { id: string }) => d.id === id).params).toEqual({
        action: 'merge',
        actif: false,
      });
      const ligne = panneau
        .getByRole('listitem')
        .filter({ has: mac.getByRole('button', { name: 'Annuler', exact: true }) });
      const details = ligne.locator('details');
      await expect(details).not.toHaveAttribute('open');
      await details.getByText('Paramètres signés', { exact: true }).click();
      await expect(details).toHaveAttribute('open');
      await expect(details).toContainText('Action : merge');
      await expect(details).toContainText('Actif : non');
      await telephone.getByRole('button', { name: 'Actualiser' }).click();
      // Une classe « toujours » ne fournit jamais son numéro au téléphone.
      await expect(telephone.locator('.pda-numero')).toHaveText('');
      const numero = (await mac
        .locator('strong')
        .filter({ hasText: /^\d{4}$/ })
        .textContent())!;
      await telephone
        .getByLabel(/^Retape le numéro/)
        .fill(faux ? (numero === '0000' ? '0001' : '0000') : numero);
      await telephone.getByRole('button', { name: 'Confirmer', exact: true }).click();
      // Le sectionnement n'a pas de nom accessible : localiser par son titre.
      const resultat = telephone
        .locator('section')
        .filter({ has: telephone.getByRole('heading', { name: 'Réponses récentes' }) })
        .locator('article')
        .last();
      await expect(resultat).toContainText('En attente du résultat');
      const attendu = faux ? 'annulee' : 'executee';
      await expect
        .poll(
          () =>
            (
              base!.prepare('SELECT resultat FROM pda_demandes WHERE id = ?').get(id) as {
                resultat: string;
              }
            ).resultat,
          { timeout: 35_000 },
        )
        .toBe(attendu);
      // La publication suit au prochain tour du daemon (15 s), sans crochet produit.
      await new Promise((resolve) => setTimeout(resolve, 16_000));
      await telephone.clock.setSystemTime(new Date());
      await telephone.clock.fastForward(20_000);
      await expect(resultat).toContainText(faux ? 'Annulée : numéro faux' : 'Exécutée');
      if (!faux) {
        await mac.reload();
        const recente = panneau.getByRole('listitem').filter({ hasText: 'Exécutée' });
        await expect(recente).toBeVisible();
        await expect(recente.locator('details')).not.toHaveAttribute('open');
        await recente.getByText('Paramètres signés', { exact: true }).click();
        await expect(recente.locator('details')).toContainText('Action : merge');
        await expect(recente.locator('details')).toContainText('Actif : non');
        await panneau.getByRole('switch', { name: 'Merge', exact: true }).click();
        await expect(panneau.getByRole('switch', { name: 'Merge', exact: true })).toBeChecked();
      }
    }
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
