import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Browser, expect, type Page } from '@playwright/test';
import { node } from './helpers.js';
import { fauxTailscale, NOM_E2E } from './serve-local.js';

const CLI = join(import.meta.dirname, '../dist/cli/aid.js');
export const ORIGINE_APPAREIL = `https://${NOM_E2E}`;

export function demarrerHost(PORT: number, supplement = '', chemin = process.env.PATH) {
  const PORT_APPAREILS = PORT + 20;
  let home = '';
  let token = '';
  home = realpathSync(mkdtempSync(join(tmpdir(), 'aid-e2e-host-')));
  const bin = join(home, 'tailscale');
  writeFileSync(bin, fauxTailscale(PORT_APPAREILS), { mode: 0o700 });
  writeFileSync(
    join(home, 'config.yaml'),
    [
      `port: ${PORT}`,
      'mesh:',
      '  tailscale:',
      '    manage: false',
      `    bin: ${bin}`,
      supplement,
      'modeHost:',
      '  actif: true',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  const env = {
    ...process.env,
    AID_HOME: home,
    AID_NO_BROWSER: '1',
    SHELL: '/bin/sh',
    PATH: chemin,
  };
  execFileSync(process.execPath, [CLI], { env, timeout: 40_000 });
  token = (JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8')) as { token: string }).token;
  return { home, token };
}

/** Le parcours de D176 entre le Mac et un appareil. Rend la page de l'appareil, en mode appareil. */
export async function appairerHost(
  browser: Browser,
  mac: Page,
  port: number,
  nom: string,
  viewport = { width: 1000, height: 800 },
): Promise<Page> {
  await mac.goto(`http://127.0.0.1:${port}/machines`);
  await expect(node(mac, 'machines.cockpit.mode')).toHaveText('Mode host actif');
  const reponse = mac.waitForResponse(
    (r) => r.url().endsWith('/api/host/appairages') && r.request().method() === 'POST',
  );
  await node(mac, 'host.ajouter').click();
  const { url } = (await (await reponse).json()) as { url: string };
  expect(url).toMatch(new RegExp(`^${ORIGINE_APPAREIL}/appairer#`));
  await expect(node(mac, 'host.qr')).toBeVisible();

  const p = await (await browser.newContext({ ignoreHTTPSErrors: true, viewport })).newPage();
  // D179 (branche prudente) : le plafond est global, 5 réclamations par minute en tout. Les
  // épreuves en font plus : sur « Trop d'essais » (429), on attend et on rouvre le même lien.
  for (let essai = 0; ; essai++) {
    // sinon le même lien n'est qu'une navigation de fragment : la page ne relirait pas le code
    if (essai > 0) await p.goto('about:blank');
    await p.goto(url);
    // le code quitte l'adresse dès l'ouverture
    await expect.poll(() => new URL(p.url()).hash).toBe('');
    await node(p, 'appairer.nom').fill(nom);
    await node(p, 'appairer.demander').click();
    await expect(node(p, 'appairer.code-court').or(node(p, 'appairer.erreur'))).toBeVisible();
    if (await node(p, 'appairer.code-court').isVisible()) break;
    await expect(node(p, 'appairer.erreur')).toHaveText(
      'Trop d’essais : réessaie dans une minute.',
    );
    expect(essai).toBeLessThan(8);
    await p.waitForTimeout(10_000);
  }
  const code = (await node(p, 'appairer.code-court').textContent())!.trim();
  expect(code).toMatch(/^[A-Z0-9]{3}-[A-Z0-9]{3}$/);

  // le Mac voit le même code court, le nom, et l'identité que le frontal a posée
  await expect(node(mac, 'host.demande.code-court')).toHaveText(code);
  await expect(node(mac, 'host.demande.nom')).toHaveText(nom);
  await expect(node(mac, 'host.demande.identite')).toHaveText(
    'utilisateur@exemple (non vérifiable)',
  );
  await node(mac, 'host.demande.approuver').click();

  await expect(node(p, 'appareil.barre')).toBeVisible();
  await expect(node(mac, 'host.demande.fin')).toHaveText('Appareil ajouté. L’accès dure 8 heures.');
  await node(mac, 'host.fermer').click();
  return p;
}
