import { access, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { expect } from './test.js';
import { preparerAudit, PORT_AUDIT } from './audit/environnement.js';
import { explorer } from './audit/explorateur.js';
import { capturerBoutons } from './captures-boutons.js';
import { CLASSES } from './audit/classement.js';

import { test } from './test-audit.js';

test('explorateur : saisie, filtre et confirmation annulée sur deux écrans', async ({
  audit: environnement,
}) => {
  test.setTimeout(110_000);
  const mac = environnement.ecrans.find((e) => e.nom === 'Mac /machines')!;
  const etatInitial = await mac.page.request.get(new URL('/api/state', mac.chemin).href, {
    headers: { 'x-aid-cockpit': '1' },
  });
  const agents = (await etatInitial.json()).agents.filter(
    (a: { status: string }) => a.status === 'idle',
  );
  expect(agents).toHaveLength(2);
  expect(agents.map((a: { kind: string }) => a.kind).sort()).toEqual(['claude', 'codex']);
  // Fixture jetable : couper le PDA libère le champ relais, sans révoquer l'appareil.
  const pda = await mac.page.request.put(new URL('/api/host/pda', mac.chemin).href, {
    headers: { origin: new URL(mac.chemin).origin, 'x-aid-cockpit': '1' },
    data: { actif: false },
  });
  expect(pda.ok()).toBe(true);
  const dossier = await mkdtemp(join(tmpdir(), 'aid-audit-essai-'));
  {
    const rapport = await explorer({
      ...environnement,
      ecrans: environnement.ecrans.filter(
        (e) => e.nom === 'Mac /boite' || e.nom === 'Mac /machines',
      ),
      dossier,
      choisirElements: (e) =>
        e.node === '1-2.filtres.nature-tout' ||
        e.node === 'machines.pda.relais' ||
        !!e.node?.startsWith('machines.pda.revoquer-'),
    });
    expect(rapport.ecrans).toHaveLength(4);
    expect(rapport.ecrans.every((e) => !e.erreurChargement)).toBe(true);
    expect(rapport.resultats.some((r) => r.observation.saisie === 'https://example.com')).toBe(
      true,
    );
    expect(rapport.resultats.some((r) => r.observation.filtreChange)).toBe(true);
    expect(rapport.resultats.some((r) => r.classe === 'annulé')).toBe(true);
    const appareils = await mac.page.request.get(new URL('/api/host/appareils', mac.chemin).href, {
      headers: { 'x-aid-cockpit': '1' },
    });
    expect((await appareils.json()).some((a: { nom: string }) => a.nom === 'Appareil audit')).toBe(
      true,
    );

    for (const resultat of rapport.resultats) {
      expect(resultat.exclusion !== null || CLASSES.includes(resultat.classe!)).toBe(true);
      expect(resultat.observation.requetes.every((r) => Object.keys(r).join() === 'chemin')).toBe(
        true,
      );
      expect(
        resultat.observation.reponses.every(
          (r) => Object.keys(r).sort().join() === 'chemin,statut',
        ),
      ).toBe(true);
    }
    expect(JSON.parse(await readFile(join(dossier, 'rapport.json'), 'utf8'))).toEqual(rapport);
    expect(await readFile(join(dossier, 'rapport.md'), 'utf8')).toContain('| Classe | Écran |');
    for (const ecran of rapport.ecrans) {
      const capture = await readFile(join(dossier, ecran.capture));
      expect(capture.subarray(1, 4).toString()).toBe('PNG');
    }
    // Les deux ajouts D13 portent l'action : les cliquer dans leurs écrans réels.
    const notifications = environnement.ecrans.find((e) => e.nom === 'appareil /notifications')!;
    for (const format of [
      { width: 1280, height: 800 },
      { width: 390, height: 844 },
    ]) {
      await notifications.page.setViewportSize(format);
      await notifications.page.goto(notifications.chemin);
      const lien = notifications.page.locator('[data-node="appareil.notifications.appareils"]');
      await capturerBoutons(notifications.page, '56-7-notifications-d13', lien);
      await lien.click();
      await expect(notifications.page).toHaveURL(/\/appareils$/);
      await expect(
        notifications.page.getByRole('heading', { name: 'Appareils connectés' }),
      ).toBeVisible();
      await mac.page.setViewportSize(format);
      await mac.page.goto(new URL('/swarph', mac.chemin).href);
      const avis = mac.page.locator('[data-node^="swarph.avis.ouvrir-"]').first();
      await capturerBoutons(mac.page, '56-7-swarph-d13', avis);
      const reponse = mac.page.waitForResponse((r) =>
        new URL(r.url()).pathname.startsWith('/api/swairm/asks/'),
      );
      await avis.click();
      expect((await reponse).ok()).toBe(true);
      await expect(mac.page.getByRole('heading', { name: 'Avis archivés' })).toBeVisible();
    }
    const noms = new Set<string>();
    const creationServeur = environnement.ecrans.find((e) => e.nom === 'Mac /serveurs/nouveau')!;
    const configurationServeur = environnement.ecrans.find((e) =>
      e.nom.endsWith('/configuration'),
    )!;
    for (const ecran of [creationServeur, creationServeur, configurationServeur]) {
      await ecran.page.goto(ecran.chemin);
      await environnement.preparerAction(ecran, { node: 'serveur-config.enregistrer' });
      const nom = await ecran.page.locator('[data-node="serveur-config.nom"]').inputValue();
      expect(noms.has(nom)).toBe(false);
      noms.add(nom);
      const reponse = ecran.page.waitForResponse(
        (r) =>
          new URL(r.url()).pathname.startsWith('/api/servers') &&
          ['POST', 'PATCH'].includes(r.request().method()),
      );
      await ecran.page.locator('[data-node="serveur-config.enregistrer"]').click();
      expect((await reponse).ok()).toBe(true);
      const serveurs = await ecran.page.request.get(new URL('/api/servers', mac.chemin).href, {
        headers: { 'x-aid-cockpit': '1' },
      });
      expect((await serveurs.json()).some((s: { name: string }) => s.name === nom)).toBe(true);
    }
    // L'acceptation est exercée sur la fixture remise à neuf, après le parcours.
    await environnement.remettreANeuf();
    await mac.page.goto(mac.chemin);
    mac.page.once('dialog', (d) => d.accept());
    await mac.page.locator('[data-node^="machines.pda.revoquer-"]').click();
    await expect
      .poll(async () => {
        const r = await mac.page.request.get(new URL('/api/host/pda/appareils', mac.chemin).href, {
          headers: { 'x-aid-cockpit': '1' },
        });
        return (await r.json()).find((a: { nom: string }) => a.nom === 'PDA audit')?.etat;
      })
      .toBe('revoque');
    await expect(mac.page.getByText('Mode host actif', { exact: true })).toBeVisible();
  }
});

test('préparation échouée : tous les ports de l’audit sont libérés', async ({ browser }) => {
  test.setTimeout(110_000);
  let homeAudit = '';
  let dossierFaux = '';
  await expect(
    preparerAudit(browser, {
      apresPreparation: async ({ home, dossier }) => {
        homeAudit = home;
        dossierFaux = dossier;
        const contexte = browser.contexts()[0]!;
        const fermerContexte = contexte.close.bind(contexte);
        contexte.close = async () => {
          await fermerContexte();
          throw new Error('Échec synthétique de fermeture');
        };
        throw new Error('Échec synthétique de préparation');
      },
    }),
  ).rejects.toThrow('Préparation et nettoyage audit');
  expect(homeAudit).not.toBe('');
  await expect(access(homeAudit)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(access(dossierFaux)).rejects.toMatchObject({ code: 'ENOENT' });
  for (const port of [
    PORT_AUDIT,
    PORT_AUDIT + 20,
    PORT_AUDIT + 30,
    PORT_AUDIT + 31,
    PORT_AUDIT + 32,
  ]) {
    const serveur = createServer();
    await new Promise<void>((resolve, reject) => {
      serveur.once('error', reject);
      serveur.listen(port, '127.0.0.1', resolve);
    });
    await new Promise<void>((resolve, reject) => serveur.close((e) => (e ? reject(e) : resolve())));
  }
});

test('PDA : essais frais après redémarrage, Confirmer et Refuser atteignent le daemon', async ({
  audit: environnement,
}) => {
  test.setTimeout(110_000);
  // D210 : la demande de la préparation ne survit pas à ce redémarrage.
  await environnement.remettreANeuf();
  const dossier = await mkdtemp(join(tmpdir(), 'aid-audit-pda-'));
  const rapport = await explorer({
    ...environnement,
    ecrans: environnement.ecrans.filter((e) => e.nom === 'PDA /pda'),
    // La logique de renouvellement est identique aux deux tailles ; l'audit ciblé couvre les deux.
    formats: [{ width: 390, height: 844 }],
    dossier,
  });
  expect(rapport.ecrans).toHaveLength(1);
  expect(rapport.ecrans.every((e) => !e.erreurChargement)).toBe(true);
  const mac = environnement.ecrans.find((e) => e.nom === 'Mac /machines')!;
  for (const [action, etat] of [
    ['confirmer', 'confirmee'],
    ['refuser', 'refusee'],
  ]) {
    const clics = rapport.resultats.filter((r) => r.node?.endsWith(`.${action}`));
    expect(clics).toHaveLength(1);
    for (const clic of clics) {
      expect(clic.classe).toBe('ok');
      const id = clic.node!.split('.')[2]!;
      expect(clic.observation.requetes.some((r) => r.chemin === `/reponses/${id}`)).toBe(true);
      await expect
        .poll(async () => {
          const reponse = await mac.page.request.get(
            new URL(`/api/host/pda/demandes/${id}`, mac.chemin).href,
            {
              headers: { 'x-aid-cockpit': '1' },
            },
          );
          return (await reponse.json()).etat;
        })
        .toBe(etat);
    }
  }
});
