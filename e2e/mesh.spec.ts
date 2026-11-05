import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  createTopic,
  newRepo,
  node,
  openApp,
  registerWorkspace,
  state,
  terminalText,
} from './helpers.js';
import { fermerContextes } from './helpers.js';

test.afterAll(({ browser }) => fermerContextes(browser));

// 12.7 : le mesh swarph de bout en bout sur les faux binaires (global-setup : `mesh.cell` morzu-mac,
// fake-swarph.sh, fake-tailscale.sh). Aucun réseau, aucun token, aucun vrai swarph.

const home = () => process.env.AID_E2E_HOME!;
const inboxLog = () => join(home(), 'swarph_state', 'morzu-mac', 'mesh-sidecar', 'inbox.log');
const dm = (id: number, kind: string, content: string) =>
  JSON.stringify({
    id,
    thread_id: `th_${id}`,
    from_node: 'mesh-gw',
    to_node: 'morzu-mac',
    kind,
    content,
    created_at: `2026-10-20T10:00:${String(id).padStart(2, '0')}+02:00`,
    read_at: null,
    priority: 'normal',
    reply_to: null,
    obligation_id: null,
    related_task_id: null,
  }) + '\n';

test('connecter depuis Réglages, trois DM arrivent dans la Boîte, « Vu », déconnecter après confirmation', async ({
  browser,
}) => {
  const page = await openApp(await browser.newContext());
  await expect(node(page, '1-1.barre.mesh.texte')).toHaveText(/^(hors mesh|monitor arrêté)/);

  // le dossier du sidecar existe avant la connexion : le suiveur s'y abonne (sinon il sonde toutes les 5 s)
  mkdirSync(join(inboxLog(), '..'), { recursive: true });
  // 25.4 (D99) : la pastille ne bascule plus rien, elle mène à Réglages, section Mesh (D100)
  await node(page, '1-1.barre.mesh').click();
  await expect(page).toHaveURL(/\/reglages#mesh$/);
  await node(page, 'reglages.mesh.connecter').click();
  await expect(node(page, 'reglages.barre.mesh.texte')).toHaveText('monitor actif · 0 à traiter');
  await expect(node(page, 'reglages.mesh.etat')).toHaveText('monitor actif · 0 à traiter');
  // le monitor a bien été lancé pour cette cell, en mode pull, par le faux swarph
  expect(readFileSync(join(home(), 'swarph.log'), 'utf8')).toContain(
    'monitor start --as morzu-mac --deliver pull',
  );

  appendFileSync(
    inboxLog(),
    dm(1, 'question', 'Tu lis le board swarph depuis A-I-D ?') +
      dm(2, 'fyi', 'monitor du VPS relancé') +
      dm(3, 'unblock', '<b>pas du HTML</b>'),
  );
  await expect(node(page, 'reglages.barre.mesh.texte')).toHaveText('monitor actif · 2 à traiter');

  await node(page, 'reglages.barre.nav-boite').click();
  await expect(page).toHaveURL(/\/boite$/);
  await expect(node(page, '1-2.mesh')).toHaveAttribute('aria-label', 'Mesh · morzu-mac');
  await expect(node(page, '1-2.mesh.etat')).toHaveText('connecté');
  await expect(node(page, '1-2.mesh.groupe-a-traiter.compte')).toHaveText('2');
  await expect(node(page, '1-2.mesh.groupe-informations.compte')).toHaveText('1');
  await expect(node(page, '1-2.mesh.dm-1.type')).toHaveText('Question');
  await expect(node(page, '1-2.mesh.dm-1.emetteur')).toHaveText('mesh-gw');
  await expect(node(page, '1-2.mesh.dm-2.type')).toHaveText('Déblocage');
  // texte brut : la balise d'un pair s'affiche, elle n'est jamais interprétée
  await expect(node(page, '1-2.mesh.dm-2.contenu').locator('pre')).toHaveText('<b>pas du HTML</b>');
  await expect(node(page, '1-2.mesh.dm-2.contenu').locator('b')).toHaveCount(0);
  await expect(node(page, '1-2.mesh.dm-3.type')).toHaveText('Info');

  await node(page, '1-2.mesh.dm-1.vu').click();
  await expect(node(page, '1-2.barre.mesh.texte')).toHaveText('monitor actif · 1 à traiter');
  await expect(node(page, '1-2.mesh.groupe-a-traiter.compte')).toHaveText('1');
  await expect(node(page, '1-2.mesh.dm-1.type')).toHaveText('Déblocage');

  // déconnecter arrête le monitor de la cell : la confirmation le dit avant d'agir (D100)
  await node(page, '1-2.barre.mesh').click();
  await node(page, 'reglages.mesh.deconnecter').click();
  await expect(node(page, 'reglages.mesh.confirmation')).toContainText(
    'Le monitor de la cell morzu-mac s’arrête.',
  );
  expect(readFileSync(join(home(), 'swarph.log'), 'utf8')).not.toContain('monitor stop');
  await node(page, 'reglages.mesh.confirmer').click();
  await expect(node(page, 'reglages.barre.mesh.texte')).toHaveText(/^hors mesh/);
  await node(page, 'reglages.barre.nav-boite').click();
  await expect(node(page, '1-2.mesh.etat')).toHaveText('hors mesh');
  expect(readFileSync(join(home(), 'swarph.log'), 'utf8')).toContain('monitor stop');
  // Tailscale a été lu, jamais monté ni descendu (manage: false)
  const tailscale = readFileSync(join(home(), 'tailscale.log'), 'utf8');
  expect(tailscale).toContain('status --json');
  expect(tailscale).not.toMatch(/^(up|down)\b/m);
});

test('« Ouvrir la cell » depuis un DM : choix du sujet, la cell s’ouvre dans son terminal', async ({
  browser,
}) => {
  const page = await openApp(await browser.newContext());
  await registerWorkspace(page, newRepo('depot-mesh'));
  const topicId = await createTopic(page, 'Répondre au mesh');

  await page.goto(`${process.env.AID_E2E_URL}/boite`);
  await expect(node(page, '1-2.mesh')).toBeVisible();
  // les DM restés de l'épreuve précédente (jamais vus) portent le bouton
  await node(page, '1-2.mesh.dm-1.cell').click();
  // les autres épreuves ont laissé des sujets actifs : choisir le nôtre par sa branche, pas par rang
  const branch = (await state(page)).topics.find((t) => t.id === topicId)!.branch;
  await page.locator('[data-action="cell.lancer"]', { hasText: branch }).click();
  await page.waitForURL(new RegExp(`/sujets/${topicId}\\?agent=ag_`));
  const agent = (await state(page)).agents.at(-1)!;
  await expect.poll(() => terminalText(page, agent.id)).toContain('FAKE_CELL cell=');
  await expect
    .poll(() => terminalText(page, agent.id))
    .toContain('MESH_GATEWAY_URL=http://mesh-gw.example:8788');
  // une seule cell : le bouton de la Boîte devient un lien vers ce terminal
  await page.goto(`${process.env.AID_E2E_URL}/boite`);
  await expect(node(page, '1-2.mesh.dm-1.cell')).toHaveAttribute(
    'href',
    `/sujets/${topicId}?agent=${agent.id}`,
  );
});
