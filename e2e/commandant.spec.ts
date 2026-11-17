import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, renameSync, mkdirSync, rmdirSync } from 'node:fs';
import type { Server } from 'node:https';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { expect, test, type Page } from './test.js';
import { appairerHost, demarrerHost, ORIGINE_APPAREIL } from './host-helpers.js';
import { fermerContextes } from './helpers.js';
import { NOM_E2E, ouvrirServeLocal } from './serve-local.js';
import { preparerMeshes } from './helpers-multi-mesh.js';
import { capturerBoutons } from './captures-boutons.js';
import { detecterVisuel } from './visuel.js';
import {
  creerPasserelleCommandant,
  IDENTIFIANT_COCKPIT_TEST,
  ligneCommandantTest,
} from '../test/fixtures/passerelle-commandant.js';
import {
  CODES_REFUS_COMMANDANT,
  HTTP_REFUS_COMMANDANT,
  messageErreurCommandant,
  libelleReponseCommandant,
} from '../src/shared/commandant-reponse.js';

const PORT = Number(process.env.AID_E2E_PORT ?? 4871) + 14;
const FRONTAL = PORT + 30;
const FRONTAL_RELAIS = PORT + 31;
const CLI = join(import.meta.dirname, '../dist/cli/aid.js');
const RELAIS = 'https://relais.aid-e2e.example';
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
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}
async function fermer(s?: Server) {
  if (!s) return;
  s.closeAllConnections();
  await new Promise<void>((r) => s.close(() => r()));
}
async function arreter(p?: ChildProcess) {
  if (!p || p.exitCode !== null) return;
  const fin = once(p, 'exit');
  p.kill('SIGTERM');
  await fin;
}
async function capture(
  page: Page,
  nom: string,
  repere = page.getByRole('heading', { name: 'Cockpit du commandant' }),
) {
  await capturerBoutons(page, `58-3-${nom}`, repere);
  const taille = page.viewportSize();
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    expect(await detecterVisuel(page)).toEqual([]);
  }
  if (taille) await page.setViewportSize(taille);
}

test('Cockpit : Mac, PDA réel, appareils en lecture seule et refus exacts de decide', async ({
  browser,
}) => {
  test.setTimeout(900_000);
  const faux = await creerPasserelleCommandant();
  faux.lignes.set(
    1240,
    ligneCommandantTest(1240, 'decision', { question: 'Question libre ?', options: [] }),
  );
  faux.lignes.set(
    1241,
    ligneCommandantTest(1241, 'decision', {
      question: 'Session requise ?',
      options: ['oui'],
      needs_sso: true,
    }),
  );
  faux.lignes.set(
    1242,
    ligneCommandantTest(1242, 'decision', { question: 'x'.repeat(361), options: [] }),
  );
  const meshes = await preparerMeshes();
  let home = '';
  let frontal: Server | undefined;
  let frontalRelais: Server | undefined;
  let relais: ChildProcess | undefined;
  let base: Database.Database | undefined;
  const portRelais = await portLibre();
  const origineMac = `http://127.0.0.1:${PORT}`;
  try {
    const ancien = process.env.NODE_OPTIONS;
    const ancienPort = process.env.AID_E2E_RELAIS_PORT;
    let instance: ReturnType<typeof demarrerHost>;
    try {
      process.env.NODE_OPTIONS = `${ancien ?? ''} --import ${pathToFileURL(join(import.meta.dirname, 'pda-fetch.mjs')).href}`;
      process.env.AID_E2E_RELAIS_PORT = String(portRelais);
      const supplement = meshes.supplement
        .replace('  perso:\n    cell: peer-a', '  perso:\n    cell: peer-b')
        .replace(/gateway: https:\/\/[^\n]+/g, `gateway: ${faux.url}`);
      instance = demarrerHost(PORT, supplement);
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
    const mac = await (
      await browser.newContext({ viewport: { width: 1280, height: 800 } })
    ).newPage();
    await mac.goto(`${origineMac}/?token=${instance.token}`);
    await mac.goto(`${origineMac}/swarph`);
    await capture(mac, 'swarph', mac.locator('[data-node="swarph.commandant"]'));
    await mac.locator('[data-node="swarph.commandant"]').click();
    await expect(mac.getByText('Identifiant cockpit : Absent')).toBeVisible();
    // Sélecteur réel : deux meshes, pas une liste décorative.
    await mac.getByLabel('Mesh', { exact: true }).click();
    await mac.getByLabel('Mesh', { exact: true }).selectOption('perso');
    await expect(mac.getByLabel('Mesh', { exact: true })).toHaveValue('perso');
    await mac.getByLabel('Mesh', { exact: true }).selectOption('principal');
    await capture(mac, 'mac-absent');
    await mac.locator('[data-node="commandant.reglages"]').click();
    const reglages = mac.getByRole('region', { name: 'Cockpit principal', exact: true });
    const champ = reglages.getByLabel('Identifiant cockpit — principal');
    await expect(reglages.getByRole('link', { name: 'Réglages swarph' })).toHaveCount(0);
    await expect(reglages.getByRole('button', { name: 'Enregistrer', exact: true })).toBeDisabled();
    await champ.click();
    await champ.fill('invalide');
    await reglages.getByRole('button', { name: 'Enregistrer', exact: true }).click();
    await expect(reglages.getByRole('alert')).toContainText('Identifiant refusé');
    await expect(champ).toHaveValue('');
    await capture(mac, 'reglages-refus', reglages);
    async function saisir() {
      await champ.fill(IDENTIFIANT_COCKPIT_TEST);
      await reglages.getByRole('button', { name: 'Enregistrer', exact: true }).click();
      await expect(champ).toHaveValue('');
      await expect(reglages.getByText(/Identifiant cockpit : Configuré/)).toBeVisible();
    }
    await saisir();
    const perso = mac.getByRole('region', { name: 'Cockpit perso', exact: true });
    await perso.getByLabel('Identifiant cockpit — perso').click();
    await perso.getByLabel('Identifiant cockpit — perso').fill(IDENTIFIANT_COCKPIT_TEST);
    await perso.getByRole('button', { name: 'Enregistrer', exact: true }).click();
    await expect(perso.getByText(/Identifiant cockpit : Configuré/)).toBeVisible();
    expect(readFileSync(join(home, 'cockpit/perso.token'), 'utf8')).toBe(IDENTIFIANT_COCKPIT_TEST);
    await perso.getByRole('button', { name: 'Retirer', exact: true }).click();
    await expect(perso.getByText('Identifiant cockpit : Absent')).toBeVisible();
    await expect(reglages.getByText(/Identifiant cockpit : Configuré/)).toBeVisible();
    expect(readFileSync(join(home, 'cockpit/principal.token'), 'utf8')).toContain(
      IDENTIFIANT_COCKPIT_TEST,
    );
    await capture(mac, 'reglages-configure', reglages);
    // Un dossier à la place du fichier provoque un vrai refus de suppression.
    const cheminIdentifiant = join(home, 'cockpit/principal.token');
    renameSync(cheminIdentifiant, `${cheminIdentifiant}.garde`);
    mkdirSync(cheminIdentifiant);
    await reglages.getByRole('button', { name: 'Retirer', exact: true }).click();
    await expect(reglages.getByRole('alert')).toContainText('Retrait impossible');
    await capture(mac, 'reglages-retrait-refuse', reglages);
    rmdirSync(cheminIdentifiant);
    renameSync(`${cheminIdentifiant}.garde`, cheminIdentifiant);
    await reglages.getByRole('button', { name: 'Retirer', exact: true }).click();
    await expect(reglages.getByText('Identifiant cockpit : Absent')).toBeVisible();
    await expect(reglages.getByRole('button', { name: 'Retirer', exact: true })).toHaveCount(0);
    await saisir();

    await mac.goto(`${origineMac}/swarph/commandant`);
    const relire = async () => {
      const derniere = await mac.evaluate(
        async () =>
          (await (await fetch('/api/commandant/principal')).json()).derniereLecture as
            string | null,
      );
      if (derniere)
        await mac.waitForTimeout(Math.max(0, 10_010 - (Date.now() - Date.parse(derniere))));
      await mac.getByRole('button', { name: 'Relire la file' }).click();
    };
    async function ouvrir(id: number) {
      await mac
        .locator('[data-node="commandant.ouvrir"]')
        .filter({ hasText: `#${id} —` })
        .click();
      await expect(mac.getByRole('article', { name: `Demande #${id}`, exact: true })).toBeVisible();
    }
    // La relecture d'ouverture peut encore être en cours au premier GET.
    await expect(
      mac.locator('[data-node="commandant.ouvrir"]').filter({ hasText: '#1240 —' }),
    ).toBeVisible();
    await ouvrir(1235);
    await capture(
      mac,
      'mac-question',
      mac.getByRole('article', { name: 'Demande #1235', exact: true }),
    );
    await expect(mac.getByRole('textbox', { name: 'Ta réponse', exact: true })).toHaveCount(0);
    faux.scenario.erreurListe = { http: 500, corps: { error: 'Indisponible' } };
    await relire();
    await expect(mac.getByRole('alert')).toContainText('La passerelle refuse la lecture');
    await capture(mac, 'mac-erreur-lecture', mac.getByRole('alert'));
    faux.scenario.erreurListe = null;
    await relire();
    await expect(mac.getByRole('alert')).toHaveCount(0);
    // PDA non activé : refus visible, les options restent disponibles pour recommencer.
    await mac.getByRole('button', { name: 'oui', exact: true }).click();
    await expect(mac.getByRole('alert')).toContainText('confirmations');
    await expect(mac.getByRole('button', { name: 'oui', exact: true })).toBeEnabled();
    await capture(mac, 'mac-pda-indisponible');
    for (const id of [1234, 1241, 1242]) {
      await ouvrir(id);
      await expect(
        mac.getByRole('article', { name: `Demande #${id}`, exact: true }).getByRole('button'),
      ).toHaveCount(0);
      await capture(
        mac,
        `mac-lecture-${id}`,
        mac.getByRole('article', { name: `Demande #${id}`, exact: true }),
      );
    }
    await mac.goto(`${origineMac}/machines`);
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
    await mac.getByLabel('Adresse du relais').fill(RELAIS);
    mac.once('dialog', (d) => d.accept());
    await mac.getByRole('switch', { name: 'PDA :' }).click();
    const telephone = await appairerHost(browser, mac, PORT, 'Téléphone cockpit');
    // La lecture host n'a jamais accès à la porte ou à son numéro.
    await capture(
      telephone,
      'appareil-accueil',
      telephone.locator('[data-node="appareil.accueil.commandant"]'),
    );
    await telephone.locator('[data-node="appareil.accueil.commandant"]').click();
    await telephone.getByRole('button', { name: 'Relire la file' }).click();
    await expect(
      telephone.locator('[data-node="commandant.ouvrir"]').filter({ hasText: '#1235 —' }),
    ).toBeVisible();
    for (const [id, texte] of [
      [
        1235,
        `Réponds depuis l'écran du Mac : demande #1235, digest ${faux.lignes.get(1235)!.digest.slice(0, 16)}.`,
      ],
      [1234, "Approuve dans l'onglet Command de swarph-desktop"],
      [1241, 'Cette question demande ta session SSO'],
      [1242, 'Cette question dépasse les limites'],
    ] as const) {
      await telephone
        .locator('[data-node="commandant.ouvrir"]')
        .filter({ hasText: `#${id} —` })
        .click();
      const detail = telephone.getByRole('article', { name: `Demande #${id}`, exact: true });
      await expect(detail).toContainText(texte);
      await expect(detail.getByRole('button')).toHaveCount(0);
      await capture(telephone, `appareil-${id}`, detail);
    }
    const lectureSeule = await telephone.evaluate(async () => ({
      reponse: (
        await fetch('/api/commandant/principal/demandes/1235/reponse', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ digest: 'a'.repeat(64), decision: 'oui' }),
        })
      ).status,
      numero: (await fetch('/api/confirmations/inconnu/numero')).status,
    }));
    expect(lectureSeule).toEqual({ reponse: 404, numero: 404 });
    expect(base.prepare('SELECT COUNT(*) AS n FROM pda_demandes').get()).toEqual({ n: 0 });
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
    await telephone.getByLabel('Nom de cet appareil').fill('PDA cockpit');
    await telephone.getByRole('button', { name: 'Enregistrer cet appareil', exact: true }).click();
    await expect(telephone.locator('.pda-empreinte')).toBeVisible();
    const empreinte = (await telephone.locator('.pda-empreinte').textContent())!;
    await mac.reload();
    const appareilPda = mac.getByRole('listitem').filter({ hasText: 'PDA cockpit' });
    mac.once('dialog', (d) => d.accept());
    await appareilPda.getByRole('button', { name: 'Activer', exact: true }).click();
    await expect(appareilPda.getByText('actif', { exact: true })).toBeVisible();
    expect(empreinte).toBeTruthy();
    await telephone.goto(`${ORIGINE_APPAREIL}/pda`);
    await mac.goto(`${origineMac}/swarph/commandant`);
    await ouvrir(1235);
    const avantPreparation = base.prepare('SELECT COUNT(*) AS n FROM pda_demandes').get();
    faux.lignes.get(1235)!.status = 'answered';
    await mac.getByRole('button', { name: 'oui', exact: true }).click();
    const refusPreparation = mac.getByText(
      'La demande a déjà reçu une réponse ailleurs (409 commandant_not_pending).',
      { exact: true },
    );
    await expect(refusPreparation).toBeVisible();
    await expect(refusPreparation).toHaveCount(1);
    await expect(
      mac.locator('[data-node="commandant.ouvrir"]').filter({ hasText: '#1235 —' }),
    ).toHaveCount(0);
    expect(base.prepare('SELECT COUNT(*) AS n FROM pda_demandes').get()).toEqual(avantPreparation);
    await capture(mac, 'preparer-not_pending', refusPreparation);
    faux.lignes.set(1235, ligneCommandantTest());
    await relire();
    await ouvrir(1235);
    // Un refus réel d'annulation laisse l'écran utilisable pour recommencer.
    const creationAnnulation = mac.waitForResponse(
      (r) => r.url().endsWith('/demandes/1235/reponse') && r.request().method() === 'POST',
    );
    await mac.getByRole('button', { name: 'non', exact: true }).click();
    const { confirmation: aAnnuler } = (await (await creationAnnulation).json()) as {
      confirmation: string;
    };
    await expect(mac.getByText('En attente de ton PDA')).toBeVisible();
    base.prepare("UPDATE pda_demandes SET etat = 'confirmee' WHERE id = ?").run(aAnnuler);
    const refusAnnulation = mac.waitForResponse(
      (r) =>
        r.url().endsWith(`/api/confirmations/${aAnnuler}`) && r.request().method() === 'DELETE',
    );
    await mac.locator('[data-node="confirmation.attente.annuler"]').click();
    expect((await refusAnnulation).status()).toBe(409);
    base.prepare("UPDATE pda_demandes SET etat = 'ouverte' WHERE id = ?").run(aAnnuler);
    await expect(mac.getByText('demande non ouverte', { exact: true })).toBeVisible();
    await capture(
      mac,
      'mac-annulation-refusee',
      mac.getByText('demande non ouverte', { exact: true }),
    );
    await mac.locator('[data-node="confirmation.attente.annuler"]').click();
    await expect(mac.getByRole('button', { name: 'oui', exact: true })).toBeEnabled();
    expect(base.prepare('SELECT resultat FROM pda_demandes WHERE id = ?').get(aAnnuler)).toEqual({
      resultat: 'annulee',
    });
    const reinitialiser = () => {
      faux.lignes.set(1235, ligneCommandantTest());
    };
    let panneauCapture = false;
    async function oui(id: number, reponse: string) {
      const creation = mac.waitForResponse(
        (r) => r.url().endsWith(`/demandes/${id}/reponse`) && r.request().method() === 'POST',
      );
      await mac.getByRole('button', { name: reponse, exact: true }).click();
      const r = await creation;
      expect(r.status()).toBe(202);
      const { confirmation } = (await r.json()) as { confirmation: string };
      await expect(mac.getByText('En attente de ton PDA')).toBeVisible();
      await telephone.getByRole('button', { name: 'Actualiser', exact: true }).click();
      const demande = telephone
        .locator('section')
        .filter({ has: telephone.getByRole('button', { name: 'Confirmer', exact: true }) });
      await expect(demande).toContainText(`Question : ${faux.lignes.get(id)!.params.question}`);
      await expect(demande).toContainText(`Id : ${id}`);
      await expect(demande).toContainText(`Digest : ${faux.lignes.get(id)!.digest.slice(0, 16)}`);
      for (const option of faux.lignes.get(id)!.params.options as string[])
        await expect(demande).toContainText(`Option : ${option}`);
      await expect(demande).toContainText(
        `Réponse choisie : ${reponse === 'Répondre' ? 'Réponse de test' : reponse}`,
      );
      await expect(demande).toContainText('Réponse du cockpit : elle ne vaut pas un go');
      await expect(demande.locator('.pda-numero')).toHaveText('');
      if (!panneauCapture) {
        const panneauMac = await mac.context().newPage();
        await panneauMac.goto(`${origineMac}/machines`);
        const demandeMac = panneauMac
          .getByRole('region', { name: 'Confirmations', exact: true })
          .getByRole('listitem')
          .filter({ has: panneauMac.getByRole('button', { name: 'Annuler', exact: true }) })
          .filter({ hasText: `Demande #${id}` });
        await demandeMac.getByText('Paramètres signés', { exact: true }).click();
        await expect(demandeMac).toContainText(
          `Question : ${faux.lignes.get(id)!.params.question}`,
        );
        await capture(panneauMac, 'machines-parametres-signes', demandeMac);
        await panneauMac.close();
        panneauCapture = true;
      }
      const numero = (await mac
        .locator('strong')
        .filter({ hasText: /^\d{4}$/ })
        .textContent())!;
      await telephone.getByLabel(/^Retape le numéro/).fill(numero);
      if (id === 1235 && !faux.scenario.erreurDecide)
        await capture(telephone, 'pda-question', demande);
      if (id === 1240) await capture(telephone, 'pda-libre', demande);
      await telephone.getByRole('button', { name: 'Confirmer', exact: true }).click();
      return confirmation;
    }
    const succes = await oui(1235, 'oui');
    await expect
      .poll(
        () =>
          (
            base!.prepare('SELECT resultat FROM pda_demandes WHERE id = ?').get(succes) as {
              resultat: string;
            }
          ).resultat,
        { timeout: 35_000 },
      )
      .toBe('executee');
    expect(faux.lignes.get(1235)).toMatchObject({
      status: 'answered',
      decided_via: 'cockpit',
      answer: 'oui',
    });
    await expect(mac.getByText('Répondu', { exact: true })).toBeVisible();
    await expect(
      mac.getByText(
        'Réponse du cockpit : elle ne vaut pas un go pour un réglage, une identité, un merge ou une release.',
      ),
    ).toBeVisible();
    await expect(mac.getByRole('article', { name: 'Demande #1235', exact: true })).toContainText(
      'cockpit:ck_1234abcd — cockpit',
    );
    await capture(mac, 'mac-repondu', mac.getByText('Répondu', { exact: true }));
    await relire(); // clic réel de relecture
    // Le résultat signé doit parvenir au PDA, sans un raccourci vers le daemon.
    await expect(async () => {
      await telephone.getByRole('button', { name: 'Actualiser', exact: true }).click();
      await expect(telephone.getByText('Répondu', { exact: true })).toBeVisible();
    }).toPass({ timeout: 35_000, intervals: [3000] });
    await capture(
      telephone,
      'pda-repondu',
      telephone.getByRole('heading', { name: 'Réponses récentes' }),
    );
    await ouvrir(1240);
    const libre = mac.getByRole('textbox', { name: 'Ta réponse', exact: true });
    await expect(mac.getByRole('button', { name: 'Répondre', exact: true })).toBeDisabled();
    await libre.click();
    await libre.fill('x\u200b');
    await expect(mac.getByRole('button', { name: 'Répondre', exact: true })).toBeDisabled();
    await libre.fill('  Réponse de test  ');
    await capture(mac, 'mac-libre', libre);
    const texteId = await oui(1240, 'Répondre');
    await expect
      .poll(
        () =>
          (
            base!.prepare('SELECT resultat FROM pda_demandes WHERE id = ?').get(texteId) as {
              resultat: string;
            }
          ).resultat,
        { timeout: 35_000 },
      )
      .toBe('executee');
    expect(faux.lignes.get(1240)).toMatchObject({
      answer: 'Réponse de test',
      decided_via: 'cockpit',
    });

    reinitialiser();
    faux.scenario.apresDecide = (ligne) => {
      ligne.decided_via = 'sso';
    };
    await relire();
    await ouvrir(1235);
    const renduInattendu = await oui(1235, 'oui');
    await expect
      .poll(
        () =>
          (
            base!.prepare('SELECT resultat FROM pda_demandes WHERE id = ?').get(renduInattendu) as {
              resultat: string;
            }
          ).resultat,
        { timeout: 35_000 },
      )
      .toBe('echouee');
    const messageRendu = libelleReponseCommandant('echouee', 'envoyee_rendu_inattendu');
    await expect(mac.getByText(messageRendu, { exact: true })).toBeVisible();
    await expect(
      mac.locator('[data-node="commandant.ouvrir"]').filter({ hasText: '#1235 —' }),
    ).toHaveCount(0);
    await expect(
      mac.getByRole('article', { name: 'Demande #1235', exact: true }).getByRole('button'),
    ).toHaveCount(0);
    expect(
      JSON.parse(
        (
          base.prepare('SELECT envoi FROM pda_demandes WHERE id = ?').get(renduInattendu) as {
            envoi: string;
          }
        ).envoi,
      ),
    ).toMatchObject({ code: 'envoyee_rendu_inattendu' });
    expect(faux.lignes.get(1235)?.status).toBe('answered');
    await capture(mac, 'envoyee-rendu-inattendu', mac.getByText(messageRendu, { exact: true }));
    await expect(async () => {
      await telephone.getByRole('button', { name: 'Actualiser', exact: true }).click();
      await expect(telephone.getByText(messageRendu, { exact: true })).toBeVisible();
    }).toPass({ timeout: 35_000, intervals: [3000] });
    await capture(
      telephone,
      'pda-envoyee-rendu-inattendu',
      telephone.getByText(messageRendu, { exact: true }),
    );
    faux.scenario.apresDecide = null;

    for (const code of CODES_REFUS_COMMANDANT) {
      reinitialiser();
      faux.scenario.erreurDecide = {
        http: HTTP_REFUS_COMMANDANT[code],
        corps:
          code === 'champ_requis'
            ? { detail: [{ loc: ['body', 'answer'], msg: 'Champ absent' }] }
            : { error: code, ...(code === 'not_pending' ? { status: 'answered' } : {}) },
      };
      await relire();
      await ouvrir(1235);
      const id = await oui(1235, code === 'bad_answer' ? 'non' : 'oui');
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
        .toBe('echouee');
      await expect(mac.getByText(messageErreurCommandant(code), { exact: true })).toBeVisible();
      await expect(mac.getByText(messageErreurCommandant(code), { exact: true })).toHaveCount(1);
      await expect(mac.getByText('La demande est déjà close.', { exact: true })).toHaveCount(0);
      if (code === 'not_pending') {
        await expect(
          mac.locator('[data-node="commandant.ouvrir"]').filter({ hasText: '#1235 —' }),
        ).toHaveCount(0);
        await expect(
          mac.getByRole('article', { name: 'Demande #1235', exact: true }).getByRole('button'),
        ).toHaveCount(0);
        await expect(
          mac.getByRole('article', { name: 'Demande #1235', exact: true }),
        ).toContainText('sso:exemple');
      }
      await capture(
        mac,
        `erreur-${code}`,
        mac.getByText(messageErreurCommandant(code), { exact: true }),
      );
      await expect(async () => {
        await telephone.getByRole('button', { name: 'Actualiser', exact: true }).click();
        await expect(
          telephone.getByText(messageErreurCommandant(code), { exact: true }),
        ).toBeVisible();
      }).toPass({ timeout: 35_000, intervals: [3000] });
      await capture(
        telephone,
        `pda-erreur-${code}`,
        telephone.getByText(messageErreurCommandant(code), { exact: true }),
      );
      expect(
        JSON.parse(
          (base.prepare('SELECT envoi FROM pda_demandes WHERE id = ?').get(id) as { envoi: string })
            .envoi,
        ),
      ).toMatchObject({ code, status: HTTP_REFUS_COMMANDANT[code] });
      faux.scenario.erreurDecide = null;
      // Les 401 arrêtent les lectures : nouveau collage obligatoire sur le Mac, puis reprise réelle.
      if (HTTP_REFUS_COMMANDANT[code] === 401) {
        const lectureAppareil = await telephone.context().newPage();
        await lectureAppareil.goto(`${ORIGINE_APPAREIL}/commandant`);
        await expect(
          lectureAppareil.getByText('L’identifiant cockpit se règle sur le Mac.'),
        ).toBeVisible();
        await expect(lectureAppareil.locator('input')).toHaveCount(0);
        await expect(lectureAppareil.locator('[data-node="commandant.option"]')).toHaveCount(0);
        await capture(lectureAppareil, `appareil-${code}`);
        await lectureAppareil.close();
        await mac.goto(`${origineMac}/swarph/reglages`);
        await saisir();
        await mac.goto(`${origineMac}/swarph/commandant`);
        await ouvrir(1235);
      }
      if (code !== 'not_pending')
        await expect(mac.getByRole('button', { name: 'oui', exact: true })).toBeEnabled();
    }
    // Périmée entre le oui et l'envoi : modifier le statut après la signature du téléphone.
    reinitialiser();
    await relire();
    await ouvrir(1235);
    const avantPost = faux.appels.filter((a) => a.methode === 'POST').length;
    const perimee = await oui(1235, 'oui');
    faux.lignes.get(1235)!.status = 'answered';
    await expect
      .poll(
        () =>
          (
            base!.prepare('SELECT resultat FROM pda_demandes WHERE id = ?').get(perimee) as {
              resultat: string;
            }
          ).resultat,
        { timeout: 35_000 },
      )
      .toBe('perimee');
    await expect(mac.getByText(/Périmée : la demande a changé/)).toBeVisible();
    await expect(
      mac.locator('[data-node="commandant.ouvrir"]').filter({ hasText: '#1235 —' }),
    ).toHaveCount(0);
    await expect(
      mac.getByRole('article', { name: 'Demande #1235', exact: true }).getByRole('button'),
    ).toHaveCount(0);
    expect(faux.appels.filter((a) => a.methode === 'POST')).toHaveLength(avantPost);
    await capture(mac, 'mac-perimee', mac.getByText(/Périmée : la demande a changé/));
    await expect(async () => {
      await telephone.getByRole('button', { name: 'Actualiser', exact: true }).click();
      await expect(telephone.getByText(/Périmée : la demande a changé/)).toBeVisible();
    }).toPass({ timeout: 35_000, intervals: [3000] });
    await capture(telephone, 'pda-perimee', telephone.getByText(/Périmée : la demande a changé/));
    reinitialiser();
    faux.scenario.digestFaux = true;
    await mac.goto(`${origineMac}/swarph/commandant`);
    await expect(
      mac.getByText('Demande illisible : le digest ne correspond pas — #1235'),
    ).toBeVisible();
    await expect(mac.locator('[data-node="commandant.option"]')).toHaveCount(0);
    await capture(mac, 'mac-illisible');
    await telephone.goto(`${ORIGINE_APPAREIL}/commandant`);
    await expect(
      telephone.getByText('Demande illisible : le digest ne correspond pas — #1235'),
    ).toBeVisible();
    await capture(telephone, 'appareil-illisible');
    await mac.goto(`${origineMac}/swarph/reglages`);
    await reglages.getByRole('button', { name: 'Retirer', exact: true }).click();
    await expect(reglages.getByText('Identifiant cockpit : Absent')).toBeVisible();
    await telephone.reload();
    await expect(telephone.getByText('L’identifiant cockpit se règle sur le Mac.')).toBeVisible();
    await expect(telephone.locator('input')).toHaveCount(0);
    await capture(telephone, 'appareil-absent');
    const traces =
      JSON.stringify({
        demandes: base.prepare('SELECT params, envoi, resume FROM pda_demandes').all(),
        evenements: base.prepare('SELECT * FROM events').all(),
      }) + readFileSync(join(home, 'daemon.log'), 'utf8');
    expect(traces).not.toContain(IDENTIFIANT_COCKPIT_TEST);
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
    await meshes.fermer();
    expect(nettoyages.filter((n) => n.status === 'rejected')).toEqual([]);
  }
});

test('Cockpit : battement à l’ouverture, toutes les 30 s, arrêt caché et après fermeture', async ({
  browser,
}) => {
  const page = await (await browser.newContext()).newPage();
  const origine = process.env.AID_E2E_URL!;
  await page.goto(`${origine}/?token=${process.env.AID_E2E_TOKEN}`);
  await page.clock.install();
  let battements = 0;
  page.on('request', (r) => {
    if (r.url().endsWith('/battement') && r.method() === 'POST') battements++;
  });
  await page.goto(`${origine}/swarph/commandant`);
  await expect.poll(() => battements).toBe(1);
  await page.clock.fastForward(30_000);
  await expect.poll(() => battements).toBe(2);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.fastForward(60_000);
  expect(battements).toBe(2);
  await page.evaluate(() => {
    Reflect.deleteProperty(document, 'hidden');
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => battements).toBe(3);
  await page.goto(`${origine}/swarph`);
  await page.clock.fastForward(60_000);
  expect(battements).toBe(3);
  await page.context().close();
});
