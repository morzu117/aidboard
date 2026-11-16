import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test, type Locator, type Page } from '@playwright/test';
import Database from 'better-sqlite3';
import { capturerBoutons } from './captures-boutons.js';
import {
  createTopic,
  fermerContextes,
  newRepo,
  node,
  openApp,
  registerWorkspace,
  url,
} from './helpers.js';
import { demarrerHost } from './host-helpers.js';

const CLI = join(import.meta.dirname, '../dist/cli/aid.js');
const TELEPHONE = { width: 390, height: 844 };
const port = () => Number(process.env.AID_E2E_PORT ?? 4871) + 2;
const fauxAgents = `${join(import.meta.dirname, '../test/fixtures/bin-stream')}${delimiter}${process.env.PATH}`;

test.afterAll(({ browser }) => fermerContextes(browser));

/** Position qui exposait le recouvrement par le menu fixe, puis vérification du vrai point de clic. */
async function sansRecouvrement(page: Page, bouton: Locator) {
  await bouton.scrollIntoViewIfNeeded();
  await bouton.evaluate((element) => {
    window.scrollBy(0, element.getBoundingClientRect().top - 20);
  });
  await expect(bouton).toBeInViewport();
  expect(
    await bouton.evaluate((element) => {
      const r = element.getBoundingClientRect();
      return element.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
    }),
  ).toBe(true);
}

async function cliquer(page: Page, bouton: Locator, chemin: string, statut = 200) {
  await expect(bouton).toBeEnabled();
  await sansRecouvrement(page, bouton);
  const retour = page.waitForResponse(
    (r) => new URL(r.url()).pathname === chemin && ['PUT', 'POST'].includes(r.request().method()),
  );
  await bouton.click();
  const reponse = await retour;
  expect(reponse.status()).toBe(statut);
  return reponse;
}

async function lireHost(page: Page) {
  return page.evaluate(async () => (await fetch('/api/host')).json());
}

function arreter(home: string) {
  execFileSync(process.execPath, [CLI, 'stop', '--force'], {
    env: { ...process.env, AID_HOME: home },
    timeout: 30_000,
  });
}

test('56.5 D03 : navigation dans le flux sur Accueil, Boîte, Sujet, Machines, Board et Réglages', async ({
  browser,
}) => {
  const page = await openApp(await browser.newContext({ viewport: TELEPHONE }));
  await registerWorkspace(page, newRepo('depot-telephone'));
  const sujet = await createTopic(page, 'Sujet téléphone');
  for (const [nom, route] of [
    ['accueil', '/'],
    ['boite', '/boite'],
    ['sujet', `/sujets/${sujet}`],
    ['machines', '/machines'],
    ['board', '/board'],
    ['reglages', '/reglages'],
  ]) {
    await page.goto(`${url()}${route}`);
    const menu = page.getByRole('button', { name: 'Ouvrir la navigation', exact: true });
    await expect(menu).toBeVisible();
    const barre = page.locator('.navigation-mobile');
    const corps = page.locator('.corps-ecran');
    expect(
      (await barre.boundingBox())!.y + (await barre.boundingBox())!.height,
    ).toBeLessThanOrEqual((await corps.boundingBox())!.y);
    await sansRecouvrement(page, menu);
    await menu.click();
    const volet = page.locator('.volet.est-ouvert');
    await expect(volet).toBeVisible();
    await volet.getByRole('button', { name: 'Fermer', exact: true }).click();
    await expect(volet).toHaveCount(0);
    await expect(menu).toHaveAttribute('aria-expanded', 'false');
    // Le menu défile avec le document : son rectangle suit exactement le défilement.
    await page.evaluate(() => window.scrollTo(0, 0));
    const avant = (await barre.boundingBox())!;
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const defilement = await page.evaluate(() => window.scrollY);
    expect((await barre.boundingBox())!.y).toBeCloseTo(avant.y - defilement, 0);
    await page.evaluate(() => window.scrollTo(0, 0));
    await capturerBoutons(page, `navigation-${nom}`, page.locator('.barre'));
    await expect(menu).toBeVisible();
  }
});

test('56.5 D03 D04 D05 : Machines, formulaire PDA, actions après défilement, refus et reprise', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  let refuserRelais = true;
  const depots: string[] = [];
  // Seul le relais extérieur est simulé ; toutes les routes cockpit sont celles du vrai daemon.
  const relais = createServer((req, res) => {
    req.resume();
    if (req.method === 'PUT' && req.url?.startsWith('/demandes/')) {
      if (refuserRelais) {
        res.writeHead(503).end();
        return;
      }
      depots.push(req.url.slice('/demandes/'.length));
    }
    res.setHeader('content-type', 'application/json');
    res.end(req.method === 'GET' ? '[]' : '{}');
  });
  await new Promise<void>((resolve) => relais.listen(0, '127.0.0.1', resolve));
  const portRelais = (relais.address() as { port: number }).port;
  const instance = demarrerHost(port(), '', fauxAgents, {
    env: {
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${pathToFileURL(join(import.meta.dirname, 'pda-fetch.mjs')).href}`,
      AID_E2E_RELAIS_PORT: String(portRelais),
    },
  });
  const contexte = await browser.newContext({ viewport: TELEPHONE });
  const page = await contexte.newPage();
  const db = new Database(join(instance.home, 'state.db'));
  page.on('dialog', (dialogue) => dialogue.accept());
  try {
    await page.goto(`http://127.0.0.1:${port()}/?token=${instance.token}`);
    await page.goto(`http://127.0.0.1:${port()}/machines`);
    await expect(node(page, 'machines.cockpit.mode')).toHaveText('Mode host actif');
    // Chaque case modifiée est réellement active, cliquée et relue sur le serveur.
    for (const option of ['push', 'code'] as const) {
      const caseOption = node(page, `host.${option}`);
      await cliquer(page, caseOption, `/api/host/${option}`);
      await expect(caseOption).toBeChecked();
      expect((await lireHost(page))[option]).toBe(true);
      const config = join(instance.home, 'config.yaml');
      const contenu = readFileSync(config, 'utf8');
      writeFileSync(config, 'modeHost: [\n');
      try {
        await cliquer(page, caseOption, `/api/host/${option}`, 409);
        await expect(node(page, 'host.erreur')).toContainText('config.yaml illisible');
        await expect(caseOption).toBeChecked();
        expect((await lireHost(page))[option]).toBe(true);
      } finally {
        writeFileSync(config, contenu);
      }
      await cliquer(page, caseOption, `/api/host/${option}`);
      await expect(caseOption).not.toBeChecked();
      await expect(node(page, 'host.erreur')).toHaveCount(0);
      expect((await lireHost(page))[option]).toBe(false);
    }
    const adresse = node(page, 'machines.pda.relais');
    await adresse.click();
    await adresse.fill('http://example.com');
    await cliquer(page, node(page, 'machines.pda.actif'), '/api/host/pda', 400);
    await expect(node(page, 'machines.pda').getByRole('alert')).toHaveText('relais invalide');
    expect((await lireHost(page)).pda.actif).toBe(false);
    await adresse.fill('https://relais.example.com');
    await cliquer(page, node(page, 'machines.pda.actif'), '/api/host/pda');
    await expect(node(page, 'machines.pda.actif')).toBeChecked();
    await expect(adresse).toBeDisabled();
    expect((await lireHost(page)).pda).toEqual({
      actif: true,
      relais: 'https://relais.example.com',
    });
    await expect(node(page, 'machines.pda').getByRole('alert')).toHaveCount(0);
    // Les champs sont séparés de leur titre, les cases de leur texte et le relais du bloc PDA.
    for (const viewport of [{ width: 1280, height: 800 }, TELEPHONE]) {
      await page.setViewportSize(viewport);
      for (const champ of ['relais', 'sujet']) {
        const titre = (await node(page, `machines.pda.${champ}-titre`).boundingBox())!;
        const boite = (await node(page, `machines.pda.${champ}`).boundingBox())!;
        expect(boite.y - (titre.y + titre.height)).toBeGreaterThanOrEqual(7);
      }
      const activation = (await node(page, 'machines.pda.activation-libelle').boundingBox())!;
      const titre = (await node(page, 'machines.pda.relais-titre').boundingBox())!;
      expect(titre.y - (activation.y + activation.height)).toBeGreaterThanOrEqual(11);
      for (const id of [
        'host.push-libelle',
        'host.code-libelle',
        'machines.pda.activation-libelle',
      ]) {
        const geometrie = await node(page, id).evaluate((label) => {
          const champ = label.querySelector('input')!.getBoundingClientRect();
          const texte = Array.from(label.childNodes).find(
            (n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim(),
          )!;
          const selection = document.createRange();
          selection.selectNode(texte);
          const r = selection.getBoundingClientRect();
          return {
            espace: r.left - champ.right,
            chevaucheVertical: r.top < champ.bottom && champ.top < r.bottom,
          };
        });
        expect(geometrie.espace).toBeGreaterThanOrEqual(7);
        expect(geometrie.chevaucheVertical).toBe(true);
      }
    }
    await page.setViewportSize(TELEPHONE);
    await capturerBoutons(page, 'machines-haut', node(page, 'machines.entete.titre'));
    await capturerBoutons(page, 'machines-pda', node(page, 'machines.pda'));
    const sujet = node(page, 'machines.pda.sujet');
    await sujet.click();
    await sujet.fill('Essai téléphone');
    const essai = node(page, 'machines.pda.essai');
    await cliquer(page, essai, '/api/host/pda/essai', 502);
    await expect(node(page, 'machines.pda').getByRole('alert')).toHaveText('relais injoignable');
    expect(depots).toEqual([]);
    await expect(essai).toBeEnabled();
    refuserRelais = false;
    const reponse = await cliquer(page, essai, '/api/host/pda/essai');
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    const { id } = (await reponse.json()) as { id: string };
    expect(depots).toContain(id);
    expect(db.prepare('SELECT action, etat FROM pda_demandes WHERE id = ?').get(id)).toEqual({
      action: 'essai',
      etat: 'ouverte',
    });
    await expect(node(page, 'machines.pda').getByRole('status')).toHaveText(
      'Demande envoyée, en attente…',
    );
    await expect(essai).toBeDisabled();
    await expect(node(page, 'machines.pda').getByRole('alert')).toHaveCount(0);
    await capturerBoutons(page, 'machines-defilement', essai);
    db.prepare("UPDATE pda_demandes SET etat = 'refusee' WHERE id = ?").run(id);
    await expect(node(page, 'machines.pda').getByRole('status')).toHaveText('Refusée');
    await expect(essai).toBeEnabled();
    // Couper le PDA rend à nouveau le champ du relais éditable.
    await cliquer(page, node(page, 'machines.pda.actif'), '/api/host/pda');
    await expect(adresse).toBeEnabled();
    expect((await lireHost(page)).pda.actif).toBe(false);
    const host = node(page, 'host.interrupteur');
    const config = join(instance.home, 'config.yaml');
    const contenu = readFileSync(config, 'utf8');
    writeFileSync(config, 'modeHost: [\n');
    try {
      await cliquer(page, host, '/api/host', 409);
      await expect(node(page, 'host.erreur')).toContainText('config.yaml illisible');
      expect((await lireHost(page)).actif).toBe(true);
    } finally {
      writeFileSync(config, contenu);
    }
    await cliquer(page, host, '/api/host');
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    await expect(node(page, 'machines.cockpit.mode')).toHaveText('Mode host inactif');
    expect((await lireHost(page)).actif).toBe(false);
    await expect(node(page, 'host.erreur')).toHaveCount(0);
    await cliquer(page, host, '/api/host');
    await expect(node(page, 'machines.cockpit.mode')).toHaveText('Mode host actif');
    expect((await lireHost(page)).actif).toBe(true);
  } finally {
    db.close();
    await contexte.close();
    arreter(instance.home);
    relais.closeAllConnections();
    await new Promise<void>((resolve) => relais.close(() => resolve()));
  }
});

test('56.5 D08 : discussion en une colonne, onglets et fermeture persistés, refus et reprise', async ({
  browser,
}) => {
  const instance = demarrerHost(port(), '', fauxAgents);
  const contexte = await browser.newContext({ viewport: TELEPHONE });
  const page = await contexte.newPage();
  const db = new Database(join(instance.home, 'state.db'));
  try {
    await page.goto(`http://127.0.0.1:${port()}/?token=${instance.token}`);
    const id = await page.evaluate(async () => {
      const retour = await fetch('/api/servers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Serveur téléphone',
          mode: 'command',
          target: 'true',
          loadProfile: false,
        }),
      });
      if (!retour.ok) throw new Error('Création du serveur de test refusée');
      return ((await retour.json()) as { id: string }).id;
    });
    const maintenant = new Date().toISOString();
    db.prepare(
      'INSERT INTO server_discussions (id, server_id, name, cwd, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('sd_telephone', id, 'Discussion téléphone', '~', maintenant, maintenant);
    db.prepare(
      "INSERT INTO server_agents (id, discussion_id, kind, status, permission_mode, created_at, updated_at) VALUES (?, ?, 'claude', 'stopped', 'default', ?, ?)",
    ).run('sa_telephone', 'sd_telephone', maintenant, maintenant);
    const chemin = `/api/servers/${id}/panel`;
    const preference = () => page.evaluate(async (c) => (await fetch(c)).json(), chemin);
    for (const route of [
      `/serveurs/${id}/discussion`,
      `/serveurs/${id}/discussions/sd_telephone`,
    ]) {
      await page.goto(`http://127.0.0.1:${port()}${route}`);
      await expect(node(page, 'discussion.bandeau')).toContainText('Machine injoignable');
      const menu = page.getByRole('button', { name: 'Ouvrir la navigation', exact: true });
      await menu.click();
      await page
        .locator('.volet.est-ouvert')
        .getByRole('button', { name: 'Fermer', exact: true })
        .click();
      db.exec(
        "CREATE TRIGGER telephone_refus BEFORE INSERT ON nav_pref BEGIN SELECT RAISE(ABORT, 'Écriture refusée pour la recette'); END",
      );
      try {
        const refus = await cliquer(page, node(page, 'discussion.panneau.bascule'), chemin, 500);
        await expect(node(page, 'discussion.erreur')).toHaveText((await refus.json()).error);
        expect(await preference()).toMatchObject({ open: false });
      } finally {
        db.exec('DROP TRIGGER telephone_refus');
      }
      await cliquer(page, node(page, 'discussion.panneau.bascule'), chemin);
      expect(await preference()).toMatchObject({ open: true });
      const panneau = node(page, 'discussion.panneau');
      const bandeau = node(page, 'discussion.bandeau');
      expect((await bandeau.boundingBox())!.width).toBeGreaterThan(TELEPHONE.width / 2);
      expect((await node(page, 'discussion.bandeau.constat').boundingBox())!.height).toBeLessThan(
        45,
      );
      const fil = page.locator('.discussion-colonne');
      const f = (await fil.boundingBox())!;
      const p = (await panneau.boundingBox())!;
      expect(p.y).toBeGreaterThanOrEqual(f.y + f.height - 1);
      expect(p.width).toBeGreaterThan(TELEPHONE.width * 0.95);
      // Le stockage refuse réellement les écritures, sans intercepter les routes du daemon.
      for (const [bouton, attendu] of [
        ['onglet-git', { open: true, tab: 'git' }],
        ['onglet-files', { open: true, tab: 'files' }],
        ['fermer', { open: false, tab: 'files' }],
      ] as const) {
        const avant = await preference();
        db.exec(
          "CREATE TRIGGER telephone_refus BEFORE INSERT ON nav_pref BEGIN SELECT RAISE(ABORT, 'Écriture refusée pour la recette'); END",
        );
        try {
          const refus = await cliquer(
            page,
            node(page, `discussion.panneau.${bouton}`),
            chemin,
            500,
          );
          await expect(node(page, 'discussion.erreur')).toHaveText((await refus.json()).error);
          expect(await preference()).toEqual(avant);
          await expect(panneau).toBeVisible();
        } finally {
          db.exec('DROP TRIGGER telephone_refus');
        }
        await cliquer(page, node(page, `discussion.panneau.${bouton}`), chemin);
        expect(await preference()).toEqual(attendu);
        if (bouton !== 'fermer') {
          await expect(node(page, `discussion.panneau.${bouton}`)).toHaveAttribute(
            'aria-pressed',
            'true',
          );
        } else {
          await expect(panneau).toHaveCount(0);
        }
      }
      await cliquer(page, node(page, 'discussion.panneau.bascule'), chemin);
      await page.reload();
      await expect(panneau).toBeVisible();
      await expect(node(page, 'discussion.bandeau')).toContainText('Machine injoignable');
      await capturerBoutons(page, 'discussion-serveur', bandeau);
      await capturerBoutons(page, 'discussion-panneau', node(page, 'discussion.panneau.fermer'));
      await cliquer(page, node(page, 'discussion.panneau.fermer'), chemin);
      await page.reload();
      await expect(node(page, 'discussion.panneau.bascule')).toHaveAttribute(
        'aria-pressed',
        'false',
      );
      await expect(panneau).toHaveCount(0);
    }
  } finally {
    db.close();
    await contexte.close();
    arreter(instance.home);
  }
});
