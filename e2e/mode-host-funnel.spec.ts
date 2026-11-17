import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { expect, test, type Page } from './test.js';
import { demarrerHost } from './host-helpers.js';
import { node } from './helpers.js';

const PORT = Number(process.env.AID_E2E_PORT ?? 4871) + 2;
const CLI = join(import.meta.dirname, '../dist/cli/aid.js');

async function capturerMachines(page: Page, dossier: string, etat: string) {
  mkdirSync(dossier, { recursive: true });
  for (const [width, height] of [
    [1280, 800],
    [390, 844],
  ]) {
    await page.setViewportSize({ width: width!, height: height! });
    await node(page, 'machines.cockpit').evaluate((element) =>
      element.scrollIntoView({ block: 'start' }),
    );
    await page.screenshot({ path: join(dossier, `machines-${etat}-${width}x${height}.png`) });
  }
}

test('31.14 : Funnel ferme le port dès le démarrage et refuse l’activation sur le Mac', async ({
  page,
}, info) => {
  const { home, token } = demarrerHost(PORT, '', process.env.PATH, { funnel: true });
  try {
    const resultat = await new Promise<string>((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port: PORT + 20 });
      socket.once('connect', () => {
        socket.destroy();
        resolve('ouvert');
      });
      socket.once('error', (err: NodeJS.ErrnoException) => resolve(err.code ?? 'erreur'));
      socket.setTimeout(5000, () => {
        socket.destroy();
        reject(new Error('délai de connexion'));
      });
    });
    expect(resultat).toBe('ECONNREFUSED');
    await page.addInitScript(() => localStorage.setItem('aid-e2e', '1'));
    await page.goto(`http://127.0.0.1:${PORT}/?token=${token}`);
    await expect(node(page, '1-1.barre.marque')).toBeVisible();
    await page.goto(`http://127.0.0.1:${PORT}/machines`);
    const raison = 'Funnel actif : le cockpit serait sur internet';
    await expect(node(page, 'host.raison')).toHaveText(raison);
    await expect(node(page, 'host.ajouter')).toBeDisabled();
    await expect(node(page, 'host.raison')).toHaveAttribute('role', 'alert');
    expect(
      await node(page, 'host.raison').evaluate((element) => {
        const ajouter = document.querySelector('[data-node="host.ajouter"]')!;
        return Boolean(element.compareDocumentPosition(ajouter) & Node.DOCUMENT_POSITION_FOLLOWING);
      }),
    ).toBe(true);
    await expect(node(page, 'host.ajouter')).toHaveAttribute('title', raison);
    const requetes: string[] = [];
    const noter = (requete: import('@playwright/test').Request) => {
      if (requete.method() === 'POST' && new URL(requete.url()).pathname === '/api/host/appairages')
        requetes.push(requete.method());
    };
    page.on('request', noter);
    await node(page, 'host.ajouter').click({ force: true });
    await page.waitForLoadState('networkidle');
    expect(requetes).toEqual([]);
    page.off('request', noter);
    const refus = await page.evaluate(async () => {
      const r = await fetch('/api/host/appairages', {
        method: 'POST',
        headers: { 'x-aid-cockpit': '1' },
      });
      return { status: r.status, corps: await r.json() };
    });
    expect(refus).toEqual({ status: 409, corps: { error: raison } });
    await capturerMachines(
      page,
      process.env.AID_E2E_CAPTURES ?? info.outputPath('captures'),
      'funnel',
    );

    const reponse = await page.evaluate(async () => {
      const r = await fetch('/api/host', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-aid-cockpit': '1' },
        body: JSON.stringify({ actif: true }),
      });
      return { status: r.status, corps: await r.json() };
    });
    expect(reponse).toEqual({ status: 409, corps: { error: raison } });
  } finally {
    execFileSync(process.execPath, [CLI, 'stop', '--force'], {
      env: { ...process.env, AID_HOME: home },
      timeout: 30_000,
    });
  }
});

test('31.14 : Ajouter actif, refus du serveur affiché, puis nouvel essai et QR', async ({
  page,
}, info) => {
  const { home, token } = demarrerHost(PORT);
  try {
    await page.addInitScript(() => localStorage.setItem('aid-e2e', '1'));
    await page.goto(`http://127.0.0.1:${PORT}/?token=${token}`);
    await expect(node(page, '1-1.barre.marque')).toBeVisible();
    await page.goto(`http://127.0.0.1:${PORT}/machines`);
    await expect(node(page, 'host.ajouter')).toBeEnabled();
    await capturerMachines(
      page,
      process.env.AID_E2E_CAPTURES ?? info.outputPath('captures'),
      'sans-funnel',
    );
    // Le serveur change après l'affichage : le bouton reste celui de l'état déjà lu par le Mac.
    const basculer = async (actif: boolean) =>
      page.evaluate(async (valeur) => {
        const r = await fetch('/api/host', {
          method: 'PUT',
          headers: { 'content-type': 'application/json', 'x-aid-cockpit': '1' },
          body: JSON.stringify({ actif: valeur }),
        });
        return r.status;
      }, actif);
    expect(await basculer(false)).toBe(200);
    const refus = page.waitForResponse(
      (r) => r.request().method() === 'POST' && r.url().endsWith('/api/host/appairages'),
    );
    await node(page, 'host.ajouter').click();
    expect((await refus).status()).toBe(409);
    await expect(node(page, 'host.erreur')).toHaveText('mode host éteint');
    await expect(node(page, 'host.qr')).toHaveCount(0);
    expect(await basculer(true)).toBe(200);
    await expect(node(page, 'host.ajouter')).toBeEnabled();
    const creation = page.waitForResponse(
      (r) => r.request().method() === 'POST' && r.url().endsWith('/api/host/appairages'),
    );
    await node(page, 'host.ajouter').click();
    expect((await creation).status()).toBe(200);
    await expect(node(page, 'host.qr')).toBeVisible();
    await expect(node(page, 'host.erreur')).toHaveCount(0);
  } finally {
    execFileSync(process.execPath, [CLI, 'stop', '--force'], {
      env: { ...process.env, AID_HOME: home },
      timeout: 30_000,
    });
  }
});
