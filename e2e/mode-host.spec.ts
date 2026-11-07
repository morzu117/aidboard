import { execFileSync } from 'node:child_process';
import type { Server } from 'node:https';
import { join } from 'node:path';
import { type Browser, type BrowserContext, expect, type Page, test } from '@playwright/test';
import { appairerHost, demarrerHost } from './host-helpers.js';
import { createTopic, fermerContextes, newRepo, node, registerWorkspace } from './helpers.js';
import { NOM_E2E, ouvrirServeLocal } from './serve-local.js';

// Chantier 31 (31.11) : l'e2e de la frontière du mode host. Son propre daemon (port de l'e2e + 2,
// ses appareils 20 plus haut), mode host actif, une sortie `tailscale` synthétique, et devant le
// port des appareils un frontal HTTPS local qui joue Serve pour `aid-e2e.ts.net`. Chromium résout
// ce nom, port 443 compris, vers le frontal : la page a l'origine https://aid-e2e.ts.net, comme
// derrière Serve. Aucun réseau, aucun vrai nom du tailnet, aucun `tailscale serve` lancé.

const PORT = Number(process.env.AID_E2E_PORT ?? 4871) + 2;
const PORT_APPAREILS = PORT + 20;
const PORT_FRONTAL = PORT_APPAREILS + 10;
const CLI = join(import.meta.dirname, '../dist/cli/aid.js');
const APPAREIL = `https://${NOM_E2E}`;

test.use({
  launchOptions: { args: [`--host-resolver-rules=MAP ${NOM_E2E}:443 127.0.0.1:${PORT_FRONTAL}`] },
});
test.afterAll(({ browser }) => fermerContextes(browser));

let home = '';
let token = '';
let frontal: Server | null = null;
let mac: Page;

function demarrer() {
  ({ home, token } = demarrerHost(PORT));
}

async function appareil(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1000, height: 800 } });
}

async function appairer(browser: Browser, nom: string): Promise<Page> {
  return appairerHost(browser, mac, PORT, nom);
}

const evaluer = <T>(p: Page, f: () => Promise<T>) => p.evaluate(f);

test.describe.serial('la frontière du mode host (chantier 31)', () => {
  let topicId = '';
  let depot = '';

  test.beforeAll(async ({ browser }) => {
    demarrer();
    frontal = await ouvrirServeLocal({ dir: home, port: PORT_FRONTAL, versPort: PORT_APPAREILS });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(() => localStorage.setItem('aid-e2e', '1'));
    mac = await ctx.newPage();
    await mac.goto(`http://127.0.0.1:${PORT}/?token=${token}`);
    await expect(node(mac, '1-1.barre.marque')).toBeVisible();
    depot = newRepo('depot-host');
    await registerWorkspace(mac, depot);
    topicId = await createTopic(mac, 'Sujet vu du téléphone');
  });

  test.afterAll(async () => {
    await mac?.context().close();
    await new Promise<void>((r) => (frontal ? frontal.close(() => r()) : r()));
    if (!home) return;
    execFileSync(process.execPath, [CLI, 'stop', '--force'], {
      env: { ...process.env, AID_HOME: home },
      timeout: 30_000,
    });
  });

  test('D176, D180 : l’appairage entre le Mac et un appareil, puis le mode appareil', async ({
    browser,
  }) => {
    const p = await appairer(browser, 'Téléphone e2e');
    expect(new URL(p.url()).origin).toBe(APPAREIL);
    const navigation = p.getByRole('navigation', { name: 'Navigation', exact: true });
    await expect(navigation.getByRole('link')).toHaveText(['À traiter', 'Sujets']);
    const liens = await node(p, 'appareil')
      .locator('a')
      .evaluateAll((as) => as.map((a) => a.getAttribute('href')));
    expect(liens).toEqual(['/informations', '/notifications', '/appareils', '/', '/sujets']);
    await expect(node(p, 'appareil.barre').getByRole('link')).toHaveText([
      'Informations',
      'Notifications',
      'Appareils connectés',
    ]);
    await expect(navigation.getByRole('link', { name: 'À traiter' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    // Sans attente ni tour à relire, le sujet ne réclame rien dans À traiter.
    await expect(node(p, 'appareil.accueil.vide')).toContainText("Rien n'attend ta réponse");
    // Aucun contrôle dans cet accueil, aucun écran du Mac.
    expect(
      await node(p, 'appareil.accueil').locator('button, a, input, textarea, select, form').count(),
    ).toBe(0);
    await expect(node(p, '1-1.barre.marque')).toHaveCount(0);
    await p.goto(`${APPAREIL}/machines`);
    await expect.poll(() => new URL(p.url()).pathname).toBe('/');
    // le cookie d'appareil : __Host-, Secure, HttpOnly, SameSite=Strict, sur ce nom seul
    const cookies = await p.context().cookies();
    expect(cookies.map((c) => c.name)).toEqual(['__Host-aid_appareil']);
    expect(cookies[0]).toMatchObject({
      domain: NOM_E2E,
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'Strict',
    });
    // le Mac le liste
    await mac.goto(`http://127.0.0.1:${PORT}/machines`);
    await expect(node(mac, 'machines.cockpit.appareils')).toContainText('Téléphone e2e');
    await p.context().close();
  });

  test('D175 : l’état vu de la page est masqué, champ par champ', async ({ browser }) => {
    const p = await appairer(browser, 'Masque e2e');
    const etat = await evaluer(p, async () => {
      const r = await fetch('/api/state', { credentials: 'same-origin' });
      return { status: r.status, texte: await r.text() };
    });
    expect(etat.status).toBe(200);
    const json = JSON.parse(etat.texte) as Record<string, unknown>;
    expect(Object.keys(json).sort()).toEqual([
      'actions',
      'agents',
      'lastEventId',
      'runs',
      'topics',
      'workspaces',
    ]);
    // ni le chemin du dépôt ni celui du worktree, ni la racine, ni le jeton
    expect(etat.texte).not.toContain(depot);
    expect(etat.texte).not.toContain('worktree');
    expect(etat.texte).not.toContain(home);
    expect(etat.texte).not.toContain(token);
    const sujet = (json.topics as Array<Record<string, unknown>>).find((t) => t.id === topicId)!;
    expect(Object.keys(sujet).sort()).toEqual(
      [
        'branch',
        'createdAt',
        'id',
        'phase',
        'prNumber',
        'slug',
        'state',
        'title',
        'type',
        'updatedAt',
        'workspaceId',
      ].sort(),
    );
    await p.context().close();
  });

  test('D174 : une écriture et un terminal refusés depuis la page de l’appareil', async ({
    browser,
  }) => {
    const p = await appairer(browser, 'Refus e2e');
    const r = await evaluer(p, async () => {
      const essai = async (method: string, url: string, body?: unknown) =>
        (
          await fetch(url, {
            method,
            credentials: 'same-origin',
            headers: body ? { 'content-type': 'application/json' } : {},
            body: body ? JSON.stringify(body) : undefined,
          })
        ).status;
      const socket = (url: string) =>
        new Promise<string>((ok) => {
          const ws = new WebSocket(url);
          ws.onopen = () => ok('ouverte');
          ws.onclose = () => ok('refusée');
        });
      return {
        sujet: await essai('POST', '/api/topics', { title: 'x' }),
        mode: await essai('PUT', '/api/host', { actif: false }),
        couper: await essai('POST', '/api/host/couper', {}),
        fichiers: await essai('GET', '/api/fs/dirs'),
        pty: await socket(`wss://${location.host}/ws/pty/ag_1`),
        events: await socket(`wss://${location.host}/ws/events`),
        signal: await socket(`wss://${location.host}/ws/signal`),
      };
    });
    expect(r).toEqual({
      sujet: 404,
      mode: 404,
      couper: 404,
      fichiers: 404,
      pty: 'refusée',
      events: 'refusée',
      signal: 'ouverte',
    });
    await p.context().close();
  });

  test('D177 : révoquer depuis le Mac coupe une page ouverte, sans recharger', async ({
    browser,
  }) => {
    const p = await appairer(browser, 'Révoqué e2e');
    await expect(node(p, 'appareil.accueil.vide')).toContainText("Rien n'attend ta réponse");
    const ligne = mac.locator('[data-node^="host.appareil."]', { hasText: 'Révoqué e2e' });
    await ligne.locator('[data-node$=".revoquer"]').click();
    await expect(node(p, 'appareil.hors-acces.phrase')).toHaveText(
      'Accès coupé. Nouveau QR requis pour revenir.',
    );
    // et la requête suivante est refusée
    const s = await evaluer(
      p,
      async () => (await fetch('/api/state', { credentials: 'same-origin' })).status,
    );
    expect(s).toBe(401);
    await p.context().close();
  });

  test('D177 : Couper tous les accès coupe chaque appareil, et le Mac reste', async ({
    browser,
  }) => {
    const a = await appairer(browser, 'Couper A');
    const b = await appairer(browser, 'Couper B');
    await mac.goto(`http://127.0.0.1:${PORT}/machines`);
    await node(mac, 'host.couper').click();
    for (const p of [a, b]) {
      await expect(node(p, 'appareil.hors-acces.phrase')).toHaveText(
        'Accès coupé. Nouveau QR requis pour revenir.',
      );
    }
    await expect(node(mac, 'host.couper')).toHaveCount(0);
    await expect(node(mac, 'machines.cockpit.mode')).toHaveText('Mode host actif');
    // un rechargement ne rouvre rien
    await a.reload();
    await expect(node(a, 'appareil.hors-acces')).toHaveAttribute('data-fin', 'revoque');
    await a.context().close();
    await b.context().close();
  });

  test('D171 : le cookie et le jeton du Mac n’ouvrent rien sur le port des appareils', async ({
    browser,
  }) => {
    const session = (await mac.context().cookies()).find((c) => c.name === 'aid_session');
    expect(session).toBeDefined();
    const ctx = await appareil(browser);
    await ctx.addCookies([
      {
        name: 'aid_session',
        value: session!.value,
        domain: NOM_E2E,
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'Strict',
      },
    ]);
    const p = await ctx.newPage();
    await p.goto(`${APPAREIL}/`);
    await expect(node(p, 'appareil.hors-acces')).toHaveAttribute('data-fin', 'inconnu');
    const r = await p.evaluate(async (t) => {
      const st = (h: Record<string, string> = {}) =>
        fetch('/api/state', { credentials: 'same-origin', headers: h }).then((x) => x.status);
      return { cookie: await st(), jeton: await st({ authorization: `Bearer ${t}` }) };
    }, token);
    expect(r).toEqual({ cookie: 401, jeton: 401 });
    await ctx.close();
  });
});
