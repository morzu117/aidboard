import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import Database from 'better-sqlite3';
import { node, openApp, url } from './helpers.js';
import { fermerContextes } from './helpers.js';

test.afterAll(({ browser }) => fermerContextes(browser));

// Constat opérateur du 2026-11-02 sur le VPS : sur l'écran Discussion, la page défilait et le champ de
// saisie restait sous le bas de la fenêtre. jsdom n'applique pas le CSS : seul un e2e le voit.

test('écran Discussion : la page ne défile pas, le champ de saisie est dans la fenêtre', async ({
  browser,
}) => {
  const page = await openApp(await browser.newContext({ viewport: { width: 1440, height: 900 } }));
  // serveur en mode commande `true` : aucun ssh, aucun réseau ; ses pings échouent sans rien lancer
  // vingt serveurs : la barre gauche dépasse la fenêtre, comme celle de l'opérateur et ses groupes
  const serveurs = await page.evaluate(async () => {
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      const r = await fetch('/api/servers', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: `e2e-hauteur-${i}`,
          mode: 'command',
          target: 'true',
          loadProfile: false,
        }),
      });
      ids.push(((await r.json()) as { id: string }).id);
    }
    return ids;
  });
  const serveur = { id: serveurs[0]! };
  // la discussion et son agent arrêté, posés en base : en créer une par l'API lancerait un agent
  const db = new Database(join(process.env.AID_E2E_HOME!, 'state.db'));
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO server_discussions (id, server_id, name, cwd, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run('sd_e2e_hauteur', serveur.id, 'Hauteur', '~', now, now);
  db.prepare(
    `INSERT INTO server_agents (id, discussion_id, kind, status, permission_mode, created_at, updated_at)
     VALUES (?, ?, 'claude', 'stopped', 'default', ?, ?)`,
  ).run('sa_e2e_hauteur', 'sd_e2e_hauteur', now, now);
  db.close();

  await page.goto(`${url()}/serveurs/${serveur.id}/discussions/sd_e2e_hauteur`);
  const champ = page.locator('.discussion .composer-champ');
  await expect(champ).toBeVisible();
  await expect(node(page, 'discussion.agent.nom')).toHaveText('claude');
  // chantier 30 : les vingt serveurs arrivent dans la barre après la discussion ; mesurer avant, c'était une course
  await expect(
    page.locator('.barre-gauche').getByText('e2e-hauteur-19', { exact: true }),
  ).toBeVisible();

  const mesures = await page.evaluate(() => {
    const composer = document.querySelector('.discussion .composer')!.getBoundingClientRect();
    const barre = document.querySelector('.barre-gauche')!;
    return {
      barreContenu: barre.scrollHeight,
      barreVisible: barre.clientHeight,
      scrollHeight: document.scrollingElement!.scrollHeight,
      innerHeight: window.innerHeight,
      composerBas: composer.bottom,
    };
  });
  // la barre gauche dépasse bien la fenêtre : elle défile seule, la page non
  expect(mesures.barreContenu).toBeGreaterThan(mesures.innerHeight);
  expect(mesures.barreVisible).toBeLessThan(mesures.barreContenu);
  expect(mesures.scrollHeight).toBeLessThanOrEqual(mesures.innerHeight);
  expect(mesures.composerBas).toBeLessThanOrEqual(mesures.innerHeight);

  // les specs suivantes partagent ce daemon : les serveurs repartent (agent arrêté, rien à confirmer)
  await page.evaluate(async (ids) => {
    for (const id of ids)
      await fetch(`/api/servers/${id}?force=1`, { method: 'DELETE', credentials: 'same-origin' });
  }, serveurs);
});
