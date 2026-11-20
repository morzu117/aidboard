import { mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, type Page, type Locator } from './test.js';
import { test } from './test-audit.js';
import { optionsNavigateur, type Ecran } from './audit/environnement.js';
import { detecterVisuel } from './visuel.js';
import { node, openApp, url } from './helpers.js';

test.use({ launchOptions: optionsNavigateur });

const formats = [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
];
const cibles = (e: Ecran): string | null => {
  if (e.nom === 'appareil /appairer') return null;
  if (e.nom.startsWith('appareil ')) return 'a, .carte-board-table, input[type=checkbox]';
  if (e.nom === 'PDA /pda') return 'button, input';
  if (e.nom === 'Mac /') return '.accueil-table-scroll, .nav-vps-etat';
  if (e.nom === 'Mac /swarph') return 'button, .nav-etat-meshes';
  if (e.nom === 'Mac /boite')
    return '[data-node="boite.actions.repondre-a-blanc"], button:not([class])';
  if (e.nom === 'Mac /swarph/federation') return '[data-node="federation.requete"]';
  if (e.nom === 'Mac /swarph/memoire') return '[data-node="memoire.filtres.mode"]';
  if (e.nom === 'Mac /reglages') return 'input[type=checkbox]';
  if (e.nom === 'Mac /machines')
    return 'input[type=checkbox], [data-node="machines.pda.relais"], .combinaisons-defile';
  if (e.nom.startsWith('Mac /board/cartes/'))
    return '.carte-board-table, input[type=checkbox], [data-node="carte.actions.ecrire-une-note-a-blanc"]';
  if (e.nom === 'Mac /serveurs') return '.serveur-discussions-table';
  if (/^Mac .*\/discussions\/sd_audit$/.test(e.nom)) return '.composer-barre';
  return null;
};

async function verifier(page: Page, selection: string) {
  const defauts = [];
  for (const trouvaille of await detecterVisuel(page)) {
    if (await page.locator(trouvaille.selecteur).evaluate((e, s) => !!e.closest(s), selection))
      defauts.push(trouvaille);
  }
  expect(defauts).toEqual([]);
}

async function capturer(page: Page, nom: string) {
  const dossier = process.env.AID_E2E_CAPTURES;
  if (!dossier) return;
  await mkdir(dossier, { recursive: true });
  const taille = page.viewportSize()!;
  await page.screenshot({
    path: join(dossier, `56-8-${nom}-${taille.width}x${taille.height}.png`),
    fullPage: true,
  });
}

/** Refus réel du daemon : session retirée le temps de la requête, puis restaurée pour réessayer. */
async function verifierRefus(page: Page, bouton: Locator, chemin: string, erreur: Locator) {
  // R5 : l'écran doit avoir fini ses lectures avant que la session soit retirée, sinon elles
  // partent sans cookie et le bouton n'est jamais rendu (vu en CI sur un runner chargé).
  await expect(bouton).toBeVisible();
  const contexte = page.context();
  const cookies = await contexte.cookies();
  await contexte.clearCookies();
  try {
    const retour = page.waitForResponse(
      (r) => new URL(r.url()).pathname === chemin && r.request().method() !== 'GET',
    );
    await bouton.click();
    expect((await retour).status()).toBe(401);
    await expect(erreur).toContainText('session expirée');
  } finally {
    await contexte.addCookies(cookies);
  }
}

test('56.8 : les écrans corrigés restent lisibles aux deux formats', async ({ audit }) => {
  test.setTimeout(180_000);
  let index = 0;
  for (const ecran of audit.ecrans.filter((e) => cibles(e))) {
    index++;
    for (const format of formats) {
      await audit.reinitialiser(ecran);
      await ecran.page.setViewportSize(format);
      await ecran.page.goto(ecran.chemin, { waitUntil: 'networkidle' });
      const selection = cibles(ecran)!;
      expect(await ecran.page.locator(selection).count(), ecran.nom).toBeGreaterThan(0);
      await verifier(ecran.page, selection);
      await capturer(ecran.page, `${String(index).padStart(2, '0')}-${ecran.nom.split(' ')[0]}`);
      // Les tableaux défilent dans leur cadre sans entraîner toute la page.
      for (const tableau of await ecran.page
        .locator(
          '.carte-board-table, .combinaisons-defile, .accueil-table-scroll, .serveur-discussions-table',
        )
        .all()) {
        expect(
          await tableau.evaluate((e) => {
            const r = e.getBoundingClientRect();
            return (
              r.left >= -1 && r.right <= innerWidth + 1 && getComputedStyle(e).overflowX === 'auto'
            );
          }),
        ).toBe(true);
        await tableau.evaluate((e) => {
          e.scrollLeft = e.scrollWidth;
        });
        await verifier(ecran.page, selection);
      }
    }
  }
});

test('56.8 : champs, cases et boutons natifs exécutent leurs actions', async ({ audit }) => {
  test.setTimeout(180_000);
  // Le faux CLI multi-mesh sert normalement seulement le board par son proxy.
  // Ses lectures locales ont besoin des réponses synthétiques du même faux swarph.
  const fichierErreur = join(dirname(audit.dossierAutorise), 'lecture-erreur');
  await writeFile(
    join(dirname(audit.dossierAutorise), 'swarph'),
    `#!/bin/sh\nexport FAKE_SWARPH_BOARD_ERROR_FILE='${fichierErreur}'\nexport FAKE_SWARPH_BOARD='${join(import.meta.dirname, '../test/fixtures/board')}'\nexec '${join(import.meta.dirname, '../test/fixtures/fake-swarph.sh')}' "$@"\n`,
    { mode: 0o700 },
  );
  const mac = audit.ecrans.find((e) => e.nom === 'Mac /machines')!;
  const page = mac.page;
  const origine = new URL(mac.chemin).origin;
  for (const format of formats) {
    await audit.remettreANeuf();
    await page.setViewportSize(format);
    await page.goto(`${origine}/swarph`);
    await node(page, 'swarph.actions.ecrire-au-mesh-a-blanc').click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: 'Fermer', exact: true }).click();
    const avis = page.locator('[data-node^="swarph.avis.ouvrir-"]').first();
    await avis.click();
    await expect(page.getByRole('heading', { name: 'Avis archivés' })).toBeVisible();
    await page.goto(`${origine}/swarph`);
    const demandes = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/avis-mesh');
    await node(page, 'swarph.demandes.relire-les-demandes-au-mesh').click();
    expect((await demandes).ok()).toBe(true);
    await expect(page.getByRole('heading', { name: 'Demandes au mesh' })).toBeVisible();

    await page.goto(`${origine}/boite`);
    await page.getByRole('button', { name: 'Répondre (à blanc)' }).click();
    await expect(page.getByRole('dialog').getByLabel('Pair', { exact: true })).toHaveValue(
      'peer-b',
    );
    await page.getByRole('button', { name: 'Fermer', exact: true }).click();
    await page.goto(`${origine}/board/cartes/101?mesh=principal`);
    await node(page, 'carte.actions.ecrire-une-note-a-blanc').click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: 'Fermer', exact: true }).click();
    const filtre = node(page, 'carte-board.chronologie.filtre-fil');
    await filtre.click();
    await expect(filtre).not.toBeChecked();
    await filtre.click();
    await expect(filtre).toBeChecked();

    await page.goto(`${origine}/swarph/federation`);
    await node(page, 'federation.requete').fill('lecture test');
    await node(page, 'federation.chercher').click();
    await expect(node(page, 'federation.resultat-0')).toContainText('exemple.lecture');
    await writeFile(fichierErreur, 'forbidden');
    await node(page, 'federation.recharger').click();
    await expect(node(page, 'federation.etat')).toContainText('Tu ne peux pas lire');
    await rm(fichierErreur);
    await node(page, 'federation.recharger').click();
    await expect(node(page, 'federation.resultat-0')).toBeVisible();
    await page.goto(`${origine}/serveurs`);
    await page.locator('[data-node$=".discussion-1.reprendre"]').first().click();
    await expect(page).toHaveURL(/\/discussions\/sd_audit$/);
    await expect(
      page.getByRole('heading', { name: 'Discussion audit', exact: true }),
    ).toBeVisible();
    for (const suffixe of ['mode', 'modele', 'remote']) {
      const bouton = page.locator(`.composer-barre [data-node$=".${suffixe}"]`);
      await bouton.click();
      await expect(page.locator('.composer-menu')).toBeVisible();
      await bouton.click();
      await expect(page.locator('.composer-menu')).toHaveCount(0);
    }
    await page.goto(`${origine}/reglages`);
    const rangement = node(page, 'reglages.rangement.groupes');
    await verifierRefus(page, rangement, '/api/nav/prefs', node(page, 'reglages.rangement.erreur'));
    await expect(rangement).not.toBeChecked();
    await rangement.click();
    await expect(rangement).toBeChecked();
    await expect
      .poll(
        async () =>
          (
            await (
              await page.request.get(`${origine}/api/nav`, { headers: { 'x-aid-cockpit': '1' } })
            ).json()
          ).prefs.rangement,
      )
      .toBe('groupes');
    await rangement.click();
    await expect
      .poll(
        async () =>
          (
            await (
              await page.request.get(`${origine}/api/nav`, { headers: { 'x-aid-cockpit': '1' } })
            ).json()
          ).prefs.rangement,
      )
      .toBe('etat');

    await page.goto(mac.chemin);
    const code = node(page, 'host.code');
    await verifierRefus(page, code, '/api/host/code', node(page, 'host.erreur'));
    await expect(code).not.toBeChecked();
    await code.click();
    // D210 : ce changement protégé devient effectif après la réponse du vrai PDA.
    const numeroCode = page
      .getByText('Retape ce numéro sur le téléphone', { exact: true })
      .locator('..')
      .locator('strong');
    await expect(numeroCode).toBeVisible();
    const pda = audit.ecrans.find((e) => e.nom === 'PDA /pda')!;
    await pda.page.goto(pda.chemin, { waitUntil: 'networkidle' });
    const demandeCode = pda.page.locator('section').filter({
      has: pda.page.getByRole('heading', { name: 'Montrer le code aux appareils', exact: true }),
    });
    await demandeCode.getByRole('textbox').fill((await numeroCode.textContent())!.trim());
    await demandeCode.getByRole('button', { name: 'Confirmer', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: /^Exécutée$/ })).toBeVisible({
      timeout: 30_000,
    });
    await page.getByRole('button', { name: 'Fermer', exact: true }).click();
    await expect(code).toBeChecked();
    await expect
      .poll(
        async () =>
          (
            await (
              await page.request.get(`${origine}/api/host`, { headers: { 'x-aid-cockpit': '1' } })
            ).json()
          ).code,
      )
      .toBe(true);
    const relais = node(page, 'machines.pda.relais');
    await expect(relais).toBeDisabled();
    await verifier(page, '[data-node="machines.pda.relais"]');
    page.once('dialog', (d) => d.accept());
    await verifierRefus(
      page,
      node(page, 'machines.pda.actif'),
      '/api/host/pda',
      node(page, 'machines.pda').getByRole('alert'),
    );
    page.once('dialog', (d) => d.accept());
    await node(page, 'machines.pda.actif').click();
    await expect(relais).toBeEnabled();
    await relais.click();
    await relais.fill('https://example.com');
    await relais.fill('https://relais.aid-e2e.example');
    page.once('dialog', (d) => d.accept());
    await node(page, 'machines.pda.actif').click();
    await expect(relais).toBeDisabled();
  }
});

test('56.8 : le filtre mémoire, refus du service puis reprise', async ({ browser }) => {
  const contexte = await browser.newContext();
  const fichierErreur = join(process.env.AID_E2E_HOME!, 'board-error');
  try {
    const page = await openApp(contexte);
    for (const format of formats) {
      await page.setViewportSize(format);
      await page.goto(`${url()}/swarph/memoire`);
      await node(page, 'memoire.filtres.mode').selectOption('tag');
      await node(page, 'memoire-swarph.tag').fill('test');
      await node(page, 'memoire-swarph.lister').click();
      await expect(node(page, 'memoire-swarph.liste')).toContainText('page-test');
      await writeFile(fichierErreur, 'forbidden');
      await node(page, 'memoire-swarph.liste.recharger').click();
      await expect(node(page, 'memoire-swarph.liste.etat')).toContainText(
        "Ta cellule n'a pas, ou plus, accès à cette mémoire.",
      );
      await rm(fichierErreur);
      await node(page, 'memoire-swarph.lister').click();
      await expect(node(page, 'memoire-swarph.liste')).toContainText('page-test');
    }
  } finally {
    await rm(fichierErreur, { force: true });
    await contexte.close();
  }
});

test('56.8 : le PDA actualise et confirme avec le champ du numéro', async ({ audit }) => {
  test.setTimeout(120_000);
  const pda = audit.ecrans.find((e) => e.nom === 'PDA /pda')!;
  const mac = audit.ecrans.find((e) => e.nom === 'Mac /machines')!;
  for (const format of formats) {
    await audit.reinitialiser(pda);
    await pda.page.setViewportSize(format);
    await pda.page.goto(pda.chemin, { waitUntil: 'networkidle' });
    const retour = pda.page.waitForResponse((r) => new URL(r.url()).pathname === '/demandes');
    await node(pda.page, 'pda.actions.actualiser').click();
    expect((await retour).ok()).toBe(true);
    const numero = pda.page.locator('[data-node^="pda.demande."][data-node$=".numero"]');
    const identifiant = (await numero.getAttribute('data-node'))!.split('.')[2]!;
    const confirmer = node(pda.page, `pda.demande.${identifiant}.confirmer`);
    await expect(confirmer).toBeDisabled();
    await numero.click();
    await numero.fill((await pda.page.locator('.pda-numero').textContent())!.trim());
    await expect(confirmer).toBeEnabled();
    await verifier(pda.page, 'button, input');
    await capturer(pda.page, 'PDA-numero-rempli');
    const reponse = pda.page.waitForResponse(
      (r) => new URL(r.url()).pathname === `/reponses/${identifiant}`,
    );
    await confirmer.click();
    expect((await reponse).ok()).toBe(true);
    await expect(pda.page.getByRole('status')).toHaveText('Réponse envoyée');
    await expect
      .poll(
        async () => {
          const r = await mac.page.request.get(
            new URL(`/api/host/pda/demandes/${identifiant}`, mac.chemin).href,
            { headers: { 'x-aid-cockpit': '1' } },
          );
          return (await r.json()).etat;
        },
        { timeout: 30_000 },
      )
      .toBe('confirmee');
  }
});
