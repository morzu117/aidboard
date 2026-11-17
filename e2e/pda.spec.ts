import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:https';
import { createServer } from 'node:net';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { expect, test, type Page } from './test.js';
import { appairerHost, demarrerHost, ORIGINE_APPAREIL } from './host-helpers.js';
import { fermerContextes, node } from './helpers.js';
import { capturerBoutons } from './captures-boutons.js';
import { NOM_E2E, ouvrirServeLocal } from './serve-local.js';

const PORT = Number(process.env.AID_E2E_PORT ?? 4871) + 6;
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

test('PDA : passkey, essais, UV, révocation, rotation et coque hors ligne', async ({ browser }) => {
  test.setTimeout(600_000);
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
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
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
    await enregistrer('PDA premier');
    const envoyer = async () => {
      await expect(mac.getByLabel('Sujet', { exact: true })).toHaveCount(0);
      const retour = mac.waitForResponse(
        (r) => r.url().endsWith('/api/host/pda/essai') && r.request().method() === 'POST',
      );
      await mac.getByRole('button', { name: 'Envoyer une demande d’essai' }).click();
      const reponse = await retour;
      expect(reponse.status()).toBe(200);
      expect(reponse.request().postData()).toBeNull();
      await expect(node(mac, 'machines.pda.resultat')).toContainText('Demande envoyée');
      await capturerBoutons(mac, '56-6-panneau-pda-resultat', node(mac, 'machines.pda.resultat'));
      return (await reponse.json()).id as string;
    };
    const confirmer = async (page: Page) => {
      const numero = (await page.locator('.pda-numero').textContent())!;
      expect(numero).toMatch(/^\d{4}$/);
      await page.getByLabel('Retape le numéro').fill(numero);
      await page.getByRole('button', { name: 'Confirmer', exact: true }).click();
    };
    expect(
      await mac.evaluate(
        async () =>
          (
            await fetch('/api/host/pda/essai', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-aid-cockpit': '1' },
              body: JSON.stringify({ sujet: 'x' }),
            })
          ).status,
      ),
    ).toBe(400);
    await capturerBoutons(mac, '56-6-panneau-pda', node(mac, 'machines.pda.essai'));
    await envoyer();
    await telephone.getByRole('button', { name: 'Actualiser' }).click();
    await expect(telephone.getByRole('heading', { name: "Demande d'essai" })).toBeVisible();
    await expect(telephone.getByText('Essai confirmé', { exact: true })).toHaveCount(0);
    await confirmer(telephone);
    await expect(mac.getByText('Confirmée', { exact: true })).toBeVisible({ timeout: 30_000 });
    await envoyer();
    await telephone.getByRole('button', { name: 'Actualiser' }).click();
    await telephone.getByRole('button', { name: 'Refuser', exact: true }).click();
    await expect(mac.getByText('Refusée', { exact: true })).toBeVisible({ timeout: 30_000 });
    await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: false });
    const uv = await envoyer();
    await telephone.getByRole('button', { name: 'Actualiser' }).click();
    await confirmer(telephone);
    const etat = (id: string) =>
      (base!.prepare('SELECT etat FROM pda_demandes WHERE id = ?').get(id) as { etat: string })
        .etat;
    expect(etat(uv)).toBe('ouverte');
    await expect(mac.getByText('Confirmée', { exact: true })).toHaveCount(0);
    // Chromium peut arrêter credentials.get avant toute assertion : aucune réponse
    // n'atteint alors le daemon. Avancer l'échéance v2 pour vérifier le refus fermé.
    base!.prepare('UPDATE pda_demandes SET echeance = ? WHERE id = ?').run(Date.now() - 1, uv);
    await expect
      .poll(
        () => {
          expect(etat(uv)).not.toBe('confirmee');
          const presence = readFileSync(join(home, 'daemon.log'), 'utf8')
            .split('\n')
            .some((ligne) => ligne.includes('pda.refus') && ligne.includes('presence'));
          return presence || etat(uv) === 'expiree';
        },
        { timeout: 325_000 },
      )
      .toBe(true);
    await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: true });
    if (etat(uv) === 'ouverte') {
      await telephone.getByRole('button', { name: 'Actualiser' }).click();
      await telephone.getByRole('button', { name: 'Refuser', exact: true }).click();
      await expect(mac.getByText('Refusée', { exact: true })).toBeVisible({ timeout: 30_000 });
    } else {
      await expect(mac.getByText('Expirée', { exact: true })).toBeVisible();
    }
    mac.once('dialog', (d) => d.accept());
    await mac
      .getByRole('listitem')
      .filter({ hasText: 'PDA premier' })
      .getByRole('button', { name: 'Révoquer' })
      .click();
    const revoquee = await envoyer();
    const refus = telephone.waitForResponse(
      (r) => r.url() === `${RELAIS}/demandes` && r.status() === 401,
    );
    await telephone.getByRole('button', { name: 'Actualiser' }).click();
    await refus;
    await expect(telephone.getByRole('status')).toContainText('révoqué');
    expect(etat(revoquee)).toBe('ouverte');
    await expect(mac.getByText('Confirmée', { exact: true })).toHaveCount(0);
    // Revenir au panneau remet le suivi local à zéro ; le registre reste intact.
    await mac.reload();
    await enregistrer('PDA second');
    await telephone.getByRole('button', { name: 'Refuser', exact: true }).click();
    await expect.poll(() => etat(revoquee), { timeout: 30_000 }).toBe('refusee');
    mac.once('dialog', (d) => d.accept());
    const rotation = mac.waitForResponse(
      (r) => r.url().endsWith('/api/host/pda/cle/tourner') && r.request().method() === 'POST',
    );
    await mac.getByRole('button', { name: 'Faire tourner la clé' }).click();
    expect((await rotation).ok()).toBe(true);
    await expect(mac.getByRole('button', { name: 'Faire tourner la clé' })).toBeEnabled();
    await arreter(relais);
    await lancerRelais();
    await envoyer();
    await telephone.getByRole('button', { name: 'Actualiser' }).click();
    await expect(telephone.getByText(/demandes? illisibles? ignorée/)).toBeVisible();
    await expect(telephone.getByRole('heading', { name: "Demande d'essai" })).toHaveCount(0);
    await telephone.reload();
    await expect(telephone.getByRole('heading', { name: "Demande d'essai" })).toBeVisible();
    await telephone.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await fermer(frontal);
    frontal = undefined;
    await telephone.reload();
    await expect(telephone.getByRole('heading', { name: 'Confirmer', exact: true })).toBeVisible();
    await expect(telephone.getByRole('heading', { name: "Demande d'essai" })).toBeVisible();
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
    expect(nettoyages.filter((nettoyage) => nettoyage.status === 'rejected')).toEqual([]);
  }
});

test('56.4 D06 D12 : relais figé, nom requis, refus réels et reprise', async ({ browser }) => {
  test.setTimeout(120_000);
  let instance: ReturnType<typeof demarrerHost> | undefined;
  let frontal: Server | undefined;
  let base: Database.Database | undefined;
  const contextes = [];
  try {
    // Le transport du relais reste sur la boucle locale, sans service extérieur.
    instance = demarrerHost(
      PORT,
      '',
      `${join(import.meta.dirname, '../test/fixtures/bin-stream')}${delimiter}${process.env.PATH}`,
      {
        env: {
          NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${pathToFileURL(join(import.meta.dirname, 'pda-fetch.mjs')).href}`,
          AID_E2E_RELAIS_PORT: String(await portLibre()),
        },
      },
    );
    base = new Database(join(instance.home, 'state.db'));
    frontal = await ouvrirServeLocal({ dir: instance.home, port: FRONTAL, versPort: PORT + 20 });
    const contexte = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    contextes.push(contexte);
    const mac = await contexte.newPage();
    await mac.goto(`http://127.0.0.1:${PORT}/?token=${instance.token}`);
    await mac.goto(`http://127.0.0.1:${PORT}/machines`);
    const adresse = node(mac, 'machines.pda.relais');
    const interrupteur = node(mac, 'machines.pda.actif');
    const basculer = async (statut = 200) => {
      mac.once('dialog', (dialogue) => dialogue.accept());
      const retour = mac.waitForResponse(
        (r) => r.url().endsWith('/api/host/pda') && r.request().method() === 'PUT',
      );
      await interrupteur.click();
      expect((await retour).status()).toBe(statut);
    };
    const etat = () =>
      mac.evaluate(
        async () =>
          (await (await fetch('/api/host')).json()).pda as { actif: boolean; relais: string },
      );
    await adresse.fill(RELAIS);
    await basculer();
    await expect(adresse).toBeDisabled();
    await expect(node(mac, 'machines.pda.relais-raison')).toHaveText(
      'Coupe le PDA pour modifier le relais.',
    );
    await expect(adresse).toHaveAccessibleDescription('Coupe le PDA pour modifier le relais.');
    await capturerBoutons(mac, 'machines-pda-desactive', adresse);
    expect(await etat()).toMatchObject({ actif: true, relais: RELAIS });
    await basculer();
    await expect(adresse).toBeEnabled();
    await expect(node(mac, 'machines.pda.relais-raison')).toHaveCount(0);
    expect((await etat()).actif).toBe(false);
    await adresse.fill('https://relais.example.com');
    await capturerBoutons(mac, 'machines-pda-actif', adresse);
    await adresse.fill('http://example.com');
    await basculer(400);
    await expect(mac.getByText('relais invalide', { exact: true })).toBeVisible();
    await expect(interrupteur).not.toBeChecked();
    expect((await etat()).actif).toBe(false);
    await adresse.fill('https://relais.example.com');
    await basculer();
    await expect(interrupteur).toBeChecked();
    expect((await etat()).relais).toBe('https://relais.example.com');
    await expect(adresse).toHaveValue('https://relais.example.com');
    await expect(mac.getByText('relais invalide', { exact: true })).toHaveCount(0);
    const telephone = await appairerHost(browser, mac, PORT, 'Appareil recette');
    contextes.push(telephone.context());
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
    await telephone.goto(`${ORIGINE_APPAREIL}/pda/enregistrer`);
    const nom = node(telephone, 'pda.enregistrement.nom');
    const enregistrer = node(telephone, 'pda.enregistrement.enregistrer');
    const raison = node(telephone, 'pda.enregistrement.raison');
    await expect(enregistrer).toBeDisabled();
    await expect(nom).toHaveAttribute('required', '');
    await expect(raison).toHaveText('Saisis un nom pour enregistrer cet appareil.');
    await expect(nom).toHaveAccessibleName('Nom de cet appareil (obligatoire)');
    await expect(nom).toHaveAccessibleDescription(await raison.innerText());
    await expect(enregistrer).toHaveAccessibleDescription(await raison.innerText());
    await capturerBoutons(telephone, 'pda-enregistrement-desactive', enregistrer);
    await nom.fill('PDA recette');
    await expect(enregistrer).toBeEnabled();
    await expect(raison).toHaveCount(0);
    await expect(enregistrer).not.toHaveAttribute('aria-describedby');
    await expect(nom).not.toHaveAttribute('aria-describedby');
    await capturerBoutons(telephone, 'pda-enregistrement-actif', enregistrer);
    // La page reste ouverte pendant que le Mac coupe le PDA : vrai refus 403 du daemon.
    await basculer();
    const refus = telephone.waitForResponse(
      (r) => r.url().endsWith('/api/appareils/moi/pda') && r.request().method() === 'POST',
    );
    await enregistrer.click();
    expect((await refus).status()).toBe(403);
    await expect(telephone.getByRole('status')).toHaveText('Enregistrement refusé');
    expect(base.prepare('SELECT nom FROM pda_appareils').all()).toEqual([]);
    await expect(enregistrer).toBeEnabled();
    await basculer();
    const retour = telephone.waitForResponse(
      (r) => r.url().endsWith('/api/appareils/moi/pda') && r.request().method() === 'POST',
    );
    await enregistrer.click();
    expect((await retour).ok()).toBe(true);
    await expect(telephone.locator('.pda-empreinte')).toBeVisible();
    await expect(
      telephone.getByText('Compare-la sur le Mac, puis active cet appareil là-bas'),
    ).toBeVisible();
    expect(base.prepare('SELECT nom, etat FROM pda_appareils').all()).toEqual([
      { nom: 'PDA recette', etat: 'attente' },
    ]);
    await mac.reload();
    await expect(mac.getByRole('listitem').filter({ hasText: 'PDA recette' })).toContainText(
      'en attente',
    );
  } finally {
    await Promise.all(contextes.map((contexte) => contexte.close()));
    await fermer(frontal);
    base?.close();
    if (instance)
      execFileSync(process.execPath, [CLI, 'stop', '--force'], {
        env: { ...process.env, AID_HOME: instance.home },
        timeout: 30_000,
      });
  }
});
