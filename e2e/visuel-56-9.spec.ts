import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from '@playwright/test';
import { node } from './helpers.js';
import { test } from './audit/fixture.js';
import { optionsNavigateur } from './audit/environnement.js';
import { detecterVisuel } from './visuel.js';

test.use({ launchOptions: optionsNavigateur });

const concerne = (nom: string) =>
  /Mac \/(machines|reglages|swarph\/cells|sujets\/[^/]+(?:\/livraison)?|serveurs\/[^/]+\/(configuration|discussions\/sd_audit)|board\/cartes\/[^/]+)$/.test(
    nom,
  ) ||
  /appareil .*\/(livraison|board\/cartes\/[^/]+)$/.test(nom) ||
  nom === 'PDA /pda';

test('56.9 : captures et détecteur sur les pages entières', async ({ audit }) => {
  test.setTimeout(240_000);
  const trouvailles = [];
  let index = 0;
  for (const ecran of audit.ecrans.filter(
    (e) => concerne(e.nom) && e.nom !== 'Mac /sujets/nouveau',
  )) {
    index++;
    for (const format of [
      { width: 1280, height: 800 },
      { width: 390, height: 844 },
    ]) {
      await audit.reinitialiser(ecran);
      await ecran.page.setViewportSize(format);
      await ecran.page.goto(ecran.chemin, { waitUntil: 'networkidle' });
      if (ecran.nom.includes('/board/cartes/')) {
        await expect(node(ecran.page, 'carte-board.graphe.etape-2')).toContainText('non prise');
        await expect(node(ecran.page, 'carte-board.graphe.etape-0')).toContainText(
          'sans détenteur disponible (no registered peer',
        );
        await expect(node(ecran.page, 'carte-board.obligation-9101')).toContainText('retirée');
        await expect(node(ecran.page, 'carte-board.obligation-9101')).toContainText('demandée');
        const motsCoupes = await ecran.page.locator('.carte-board-etat').evaluateAll((cellules) =>
          cellules.flatMap((cellule) => {
            const texte = cellule.firstChild;
            if (!texte || texte.nodeType !== Node.TEXT_NODE) return [];
            return [...(texte.textContent ?? '').matchAll(/\S+/g)]
              .filter((mot) => {
                const plage = document.createRange();
                plage.setStart(texte, mot.index!);
                plage.setEnd(texte, mot.index! + mot[0].length);
                return plage.getClientRects().length > 1;
              })
              .map((mot) => mot[0]);
          }),
        );
        expect(motsCoupes).toEqual([]);
      }
      if (/Mac \/sujets\/tp_[^/]+$/.test(ecran.nom))
        await expect(node(ecran.page, '1-3.entete.etat')).toHaveText('actif');
      if (ecran.nom === 'Mac /machines') {
        const appareils = ecran.page.locator('.pda-formulaire .machines-appareils');
        await expect(appareils).toContainText(/Créé : \d{2}\/\d{2}\/\d{4}/);
        await expect(appareils).not.toContainText(/T\d{2}:\d{2}:/);
        for (const liste of await ecran.page.locator('.machines-appareils').all()) {
          const cadre = await liste.boundingBox();
          const texte = await liste.locator('li > span').first().boundingBox();
          expect(texte!.x).toBeGreaterThan(cadre!.x + 1);
        }
      }
      if (ecran.nom.startsWith('appareil ') && ecran.nom.endsWith('/livraison'))
        await expect(ecran.page.getByText('Aucun contrôle connu pour cette tête.')).toBeVisible();
      if (ecran.nom.endsWith('/discussions/sd_audit')) {
        const bandeau = await node(ecran.page, 'discussion.bandeau').boundingBox();
        const titre = await ecran.page.locator('.discussion-titres').boundingBox();
        expect(bandeau!.x).toBeCloseTo(titre!.x);
      }
      const defauts = await detecterVisuel(ecran.page);
      trouvailles.push({ ecran: ecran.nom, format, defauts });
      if (process.env.AID_E2E_CAPTURES) {
        await mkdir(process.env.AID_E2E_CAPTURES, { recursive: true });
        await ecran.page.screenshot({
          path: join(
            process.env.AID_E2E_CAPTURES,
            `56-9-${index}-${ecran.nom.split(' ')[0]}-${format.width}x${format.height}.png`,
          ),
          fullPage: true,
        });
      }
    }
  }
  if (process.env.AID_E2E_CAPTURES)
    await writeFile(
      join(process.env.AID_E2E_CAPTURES, 'visuel.json'),
      JSON.stringify(trouvailles, null, 2),
    );
  expect(
    trouvailles.flatMap((t) => t.defauts.map((d) => ({ ecran: t.ecran, format: t.format, ...d }))),
  ).toEqual([]);
});

test('56.9 : les paramètres signés, les cases et la révocation restent utilisables', async ({
  audit,
}) => {
  test.setTimeout(180_000);
  const mac = audit.ecrans.find((e) => e.nom === 'Mac /machines')!;
  const configuration = audit.ecrans.find((e) => e.nom.endsWith('/configuration'))!;
  const page = mac.page;
  const origine = new URL(mac.chemin).origin;
  for (const format of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    await audit.remettreANeuf();
    await page.setViewportSize(format);
    await page.goto(mac.chemin, { waitUntil: 'networkidle' });
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    const cle = await page.locator('.pda-formulaire > code').textContent();
    await node(page, 'machines.pda.copier').click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(cle);
    const parametres = page.locator('summary[data-node^="machines.confirmations."]').first();
    await parametres.click();
    await expect(parametres.locator('..')).toHaveAttribute('open', '');
    expect(await detecterVisuel(page)).toEqual([]);
    await parametres.click();
    await expect(parametres.locator('..')).not.toHaveAttribute('open');

    await page.goto(`${origine}/swarph/cells`, { waitUntil: 'networkidle' });
    for (const [onglet, chemin] of [
      ['federation', '/swarph/federation'],
      ['memoire', '/swarph/memoire'],
      ['reglages', '/swarph/reglages'],
      ['board', '/board'],
      ['cells', '/swarph/cells'],
    ]) {
      const lien = node(page, `onglets-swarph.${onglet}`);
      await lien.click();
      await expect(page).toHaveURL(`${origine}${chemin}`);
      await expect(lien).toHaveAttribute('aria-current', 'page');
    }
    await page.goto(configuration.chemin, { waitUntil: 'networkidle' });
    await node(page, 'serveur-config.nom').fill('Serveur synthétique de revue');
    const profil = node(page, 'serveur.configuration.profil-shell');
    const session = node(page, 'serveur-config.session');
    const destructives = node(page, 'serveur.configuration.confirmation-destructive');
    for (const caseACocher of [profil, session, destructives]) {
      const avant = await caseACocher.isChecked();
      await caseACocher.click();
      expect(await caseACocher.isChecked()).toBe(!avant);
    }
    const enregistrer = node(page, 'serveur-config.enregistrer');
    await expect(enregistrer).toBeEnabled();
    const cookies = await page.context().cookies();
    await page.context().clearCookies();
    await enregistrer.click();
    await expect(node(page, 'serveur-config.erreur')).toContainText('session expirée');
    await page.context().addCookies(cookies);
    const reponse = page.waitForResponse(
      (r) =>
        r.request().method() === 'PATCH' &&
        /\/api\/servers\/[^/]+$/.test(new URL(r.url()).pathname),
    );
    await enregistrer.click();
    expect((await reponse).ok()).toBe(true);
    const serveur = configuration.chemin.split('/').at(-2)!;
    const serveurs = await (
      await page.request.get(`${origine}/api/servers`, { headers: { 'x-aid-cockpit': '1' } })
    ).json();
    const sauve = serveurs.find((s: { id: string }) => s.id === serveur);
    expect(sauve.name).toBe('Serveur synthétique de revue');
    expect(sauve.loadProfile).toBe(true);
    expect(sauve.keepSession).toBe(false);
    expect(sauve.confirmDestructive).toBe(false);

    await page.goto(mac.chemin, { waitUntil: 'networkidle' });
    expect(await detecterVisuel(page)).toEqual([]);
    const revoquer = page.locator('.pda-formulaire [data-node^="machines.pda.revoquer-"]').first();
    await expect(revoquer).toBeEnabled();
    const appareil = (await revoquer.getAttribute('data-node'))!.replace(
      'machines.pda.revoquer-',
      '',
    );
    await page.context().clearCookies();
    page.once('dialog', (d) => d.accept());
    await revoquer.click();
    await expect(node(page, 'machines.pda').getByRole('alert')).toContainText('session expirée');
    await page.context().addCookies(cookies);
    page.once('dialog', (d) => d.accept());
    await revoquer.click();
    await expect(revoquer).toHaveCount(0);
    const appareils = await (
      await page.request.get(`${origine}/api/host/pda/appareils`, {
        headers: { 'x-aid-cockpit': '1' },
      })
    ).json();
    expect(appareils.find((a: { id: string }) => a.id === appareil).etat).toBe('revoque');
    const retirer = page.locator('[data-node^="host.appareil."][data-node$=".revoquer"]').first();
    const identifiant = (await retirer.getAttribute('data-node'))!.split('.')[2]!;
    await page.context().clearCookies();
    await retirer.click();
    await expect(node(page, 'host.erreur')).toContainText('session expirée');
    await page.context().addCookies(cookies);
    await retirer.click();
    await expect(retirer).toHaveCount(0);
    const restants = await (
      await page.request.get(`${origine}/api/host/appareils`, { headers: { 'x-aid-cockpit': '1' } })
    ).json();
    expect(restants.find((a: { id: string }) => a.id === identifiant)?.etat).not.toBe('actif');
  }
});

test('56.9 : confirmer et refuser sur le PDA, refus du relais puis reprise', async ({ audit }) => {
  test.setTimeout(180_000);
  const pda = audit.ecrans.find((e) => e.nom === 'PDA /pda')!;
  const mac = audit.ecrans.find((e) => e.nom === 'Mac /machines')!;
  for (const format of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    for (const action of ['confirmer', 'refuser']) {
      await audit.reinitialiser(pda);
      await pda.page.setViewportSize(format);
      await pda.page.goto(pda.chemin, { waitUntil: 'networkidle' });
      const numero = pda.page.locator('[data-node^="pda.demande."][data-node$=".numero"]');
      const id = (await numero.getAttribute('data-node'))!.split('.')[2]!;
      const bouton = node(pda.page, `pda.demande.${id}.${action}`);
      if (action === 'confirmer') {
        await expect(bouton).toBeDisabled();
        await numero.fill((await pda.page.locator('.pda-numero').textContent())!.trim());
      }
      await expect(bouton).toBeEnabled();
      await expect(bouton).toHaveClass(
        action === 'confirmer' ? /bouton--primaire/ : /bouton--danger/,
      );
      expect(await detecterVisuel(pda.page)).toEqual([]);
      if (process.env.AID_E2E_CAPTURES) {
        await mkdir(process.env.AID_E2E_CAPTURES, { recursive: true });
        await pda.page.screenshot({
          path: join(
            process.env.AID_E2E_CAPTURES,
            `56-9-PDA-${action}-${format.width}x${format.height}.png`,
          ),
          fullPage: true,
        });
      }
      // Le vrai relais refuse une signature invalide ; aucun endpoint du daemon n'est simulé.
      await pda.page.route('**/reponses/*', async (route) => {
        await route.continue({
          headers: { ...route.request().headers(), 'x-aid-sig': 'invalide' },
        });
      });
      const refus = pda.page.waitForResponse(
        (r) => new URL(r.url()).pathname === `/reponses/${id}`,
      );
      await bouton.click();
      expect((await refus).status()).toBe(401);
      await expect(pda.page.getByRole('status')).toContainText(
        "Cet appareil n'est pas encore activé",
      );
      await expect(bouton).toBeEnabled();
      await pda.page.unroute('**/reponses/*');
      await bouton.click();
      await expect(pda.page.getByRole('status')).toHaveText('Réponse envoyée');
      await expect
        .poll(
          async () => {
            const r = await mac.page.request.get(
              new URL(`/api/host/pda/demandes/${id}`, mac.chemin).href,
              { headers: { 'x-aid-cockpit': '1' } },
            );
            return (await r.json()).etat;
          },
          { timeout: 30_000 },
        )
        .toBe(action === 'confirmer' ? 'confirmee' : 'refusee');
    }
  }
});

test('56.9 : libellé inconnu conservé dans la fiche servie par le daemon', async ({ browser }) => {
  const { cp, mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { openApp, url } = await import('./helpers.js');
  const dossier = await mkdtemp(join(tmpdir(), 'aid-libelles-board-'));
  const home = process.env.AID_E2E_HOME!;
  const cli = join(home, 'swarph');
  const sauvegarde = await readFile(cli);
  const contexte = await browser.newContext();
  try {
    await cp(join(import.meta.dirname, '../test/fixtures/board'), dossier, { recursive: true });
    const fichier = join(dossier, 'cards-graph-101.json');
    const graphe = JSON.parse(await readFile(fichier, 'utf8'));
    graphe.steps[2].state = 'etat-inconnu';
    await writeFile(fichier, JSON.stringify(graphe));
    await writeFile(
      cli,
      `#!/bin/sh\nexport FAKE_SWARPH_BOARD='${dossier}'\nexec '${join(import.meta.dirname, '../test/fixtures/fake-swarph.sh')}' "$@"\n`,
      { mode: 0o700 },
    );
    const page = await openApp(contexte);
    for (const format of [
      { width: 1280, height: 800 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(format);
      await page.goto(`${url()}/board/cartes/101`);
      await node(page, 'carte-board.relire').click();
      await expect(node(page, 'carte-board.graphe.etape-2')).toContainText('etat-inconnu');
      expect(await detecterVisuel(page)).toEqual([]);
    }
  } finally {
    await writeFile(cli, sauvegarde);
    await contexte.close();
    await rm(dossier, { recursive: true, force: true });
  }
});
