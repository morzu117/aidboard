import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Browser, expect, type Frame, type Page, test } from '@playwright/test';
import { createTopic, fermerContextes, newRepo, node, registerWorkspace } from './helpers.js';

test.afterAll(({ browser }) => fermerContextes(browser));

// Chantier 30 (D169) : l'e2e mesure la frontière des artefacts. Il lance son daemon (port de l'e2e + 1,
// comme les specs à agents ; ses artefacts écoutent donc 10 plus haut) et un serveur « extérieur » local
// qui compte les requêtes reçues. Artefacts synthétiques seulement, aucun réseau.
const PORT = Number(process.env.AID_E2E_PORT ?? 4871) + 1;
const CLI = join(import.meta.dirname, '../dist/cli/aid.js');

let home = '';
let base = '';
let page: Page;
let worktree = '';
let exterieur: Server;
let portExterieur = 0;
const recues: string[] = [];

function demarrer(): { url: string; token: string } {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'aid-e2e-artefacts-')));
  writeFileSync(join(home, 'config.yaml'), `port: ${PORT}\n`, { mode: 0o600 });
  const env = { ...process.env, AID_HOME: home, AID_NO_BROWSER: '1', SHELL: '/bin/sh' };
  execFileSync(process.execPath, [CLI], { env, timeout: 40_000 });
  const info = JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8')) as { token: string };
  return { url: `http://127.0.0.1:${PORT}`, token: info.token };
}

async function ouvrir(browser: Browser): Promise<Page> {
  const { url, token } = demarrer();
  base = url;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => localStorage.setItem('aid-e2e', '1'));
  const p = await context.newPage();
  await p.goto(`${url}/?token=${token}`);
  await expect(node(p, '1-1.barre.marque')).toBeVisible();
  return p;
}

const EXT = () => `http://127.0.0.1:${portExterieur}`;

/** L'artefact de D169 : il mesure sa propre prison et publie son verdict dans son titre. */
const VERDICT = () => `<!doctype html>
<meta charset="utf-8"><title>en cours</title>
<h1>Frontière</h1>
<script>
(async () => {
  const v = {};
  try { v.cookie = document.cookie === '' ? 'vide' : 'lu'; } catch (e) { v.cookie = e.name; }
  try { void localStorage.length; v.localStorage = 'ouvert'; } catch (e) { v.localStorage = e.name; }
  const essai = async (u) => { try { await fetch(u); return 'atteint'; } catch (e) { return e.name; } };
  v.api = await essai('${base}/api/state');
  v.exterieur = await essai('${EXT()}/fetch');
  v.xhr = await new Promise((r) => {
    try {
      const x = new XMLHttpRequest();
      x.open('GET', '${EXT()}/xhr');
      x.onload = () => r('atteint');
      x.onerror = () => r('erreur');
      x.send();
    } catch (e) { r(e.name); }
  });
  v.websocket = await new Promise((r) => {
    try {
      const ws = new WebSocket('ws://127.0.0.1:${portExterieur}/ws');
      ws.onopen = () => r('ouvert');
      ws.onerror = () => r('erreur');
    } catch (e) { r(e.name); }
  });
  v.tauri = typeof window.__TAURI_INTERNALS__;
  document.title = 'verdict ' + JSON.stringify(v);
})();
</script>`;

/** Le titre du cadre de l'onglet, une fois chargé : le cadre est désigné par son src exact. */
async function titreDuCadre(): Promise<string> {
  const src = await node(page, '1-3.artefacts.cadre').getAttribute('src');
  const f: Frame | undefined = page.frames().find((x) => x.url() === src);
  return f ? f.title() : '';
}

async function ouvrirArtefact(nom: string) {
  await page.getByRole('button', { name: new RegExp(nom.replace('.', '\\.')) }).click();
}

test.describe.serial('la frontière des artefacts (chantier 30)', () => {
  test.beforeAll(async ({ browser }) => {
    exterieur = createServer((req, res) => {
      recues.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'text/html' }).end('<p>extérieur</p>');
    });
    exterieur.on('upgrade', (req, socket) => {
      recues.push(req.url ?? '');
      socket.destroy();
    });
    await new Promise<void>((r) => exterieur.listen(0, '127.0.0.1', r));
    portExterieur = (exterieur.address() as { port: number }).port;

    page = await ouvrir(browser);
    await registerWorkspace(page, newRepo('depot-artefacts'));
    const topicId = await createTopic(page, 'Artefacts e2e');
    const s = (await page.evaluate(async () =>
      (await fetch('/api/state', { credentials: 'same-origin' })).json(),
    )) as { topics: Array<{ id: string; worktree: string }> };
    worktree = s.topics.find((x) => x.id === topicId)!.worktree;

    mkdirSync(join(worktree, 'docs'));
    writeFileSync(join(worktree, 'docs', 'synthese.md'), '# Synthèse\n\nUn rapport en Markdown.\n');
    writeFileSync(
      join(worktree, 'schema.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect id="carre" width="40" height="40"/></svg>',
    );
    writeFileSync(join(worktree, 'verdict.html'), VERDICT());
    writeFileSync(
      join(worktree, 'vers-api.html'),
      `<!doctype html><script>location.href = '${base}/api/state';</script>`,
    );
    writeFileSync(
      join(worktree, 'vers-dehors.html'),
      `<!doctype html><script>location.href = '${EXT()}/navigation';</script>`,
    );
    writeFileSync(
      join(worktree, 'rafraichir.html'),
      `<!doctype html><meta http-equiv="refresh" content="0; url=${EXT()}/refresh">`,
    );
    await page.getByRole('tab', { name: 'Artefacts' }).click();
  });

  test.afterAll(async () => {
    await page?.context().close();
    await new Promise<void>((r) => (exterieur ? exterieur.close(() => r()) : r()));
    if (!home) return;
    execFileSync(process.execPath, [CLI, 'stop', '--force'], {
      env: { ...process.env, AID_HOME: home },
      timeout: 30_000,
    });
  });

  test('D161 : la liste, dont un Markdown rendu dans la page, sans cadre', async () => {
    const liste = node(page, '1-3.artefacts.liste');
    for (const nom of ['synthese.md', 'schema.svg', 'verdict.html', 'vers-api.html']) {
      await expect(liste).toContainText(nom);
    }
    await ouvrirArtefact('synthese.md');
    await expect(node(page, '1-3.artefacts.document')).toContainText('Un rapport en Markdown.');
    await expect(page.locator('iframe')).toHaveCount(0);
  });

  test('D164 : le SVG, servi par le second port, dans le cadre', async () => {
    await ouvrirArtefact('schema.svg');
    const cadre = node(page, '1-3.artefacts.cadre');
    await expect(cadre).toHaveAttribute('sandbox', 'allow-scripts');
    await expect(cadre).toHaveAttribute(
      'src',
      new RegExp(`^http://127\\.0\\.0\\.1:${PORT + 10}/a/`),
    );
    await expect(
      page.frameLocator('[data-node="1-3.artefacts.cadre"]').locator('#carre'),
    ).toHaveCount(1);
  });

  test('D169 : l’artefact mesure sa prison et publie son verdict', async () => {
    const avant = recues.length;
    await ouvrirArtefact('verdict.html');
    await expect(node(page, '1-3.artefacts.cadre')).toBeVisible();
    await expect.poll(titreDuCadre, { timeout: 15_000 }).toMatch(/^verdict /);
    const verdict = JSON.parse((await titreDuCadre()).slice('verdict '.length)) as Record<
      string,
      string
    >;
    // origine opaque : le cookie est illisible (ou vide), le stockage lève SecurityError
    expect(['SecurityError', 'vide']).toContain(verdict.cookie);
    expect(verdict.localStorage).toBe('SecurityError');
    // connect-src 'none' : rien ne part, ni vers le daemon ni vers l'extérieur
    expect(verdict.api).toBe('TypeError');
    expect(verdict.exterieur).toBe('TypeError');
    expect(verdict.xhr).not.toBe('atteint');
    expect(verdict.websocket).not.toBe('ouvert');
    expect(verdict.tauri).toBe('undefined');
    expect(recues.slice(avant)).toEqual([]);
    // la phrase sous le cadre dit ce qu'il reste possible
    await expect(node(page, '1-3.artefacts.frontiere')).toHaveText(
      'Ni fetch, ni XHR, ni WebSocket : cet artefact ne charge rien. Il peut encore naviguer dans son propre cadre.',
    );
  });

  // Mesuré sous Chromium (30.7) : dans le cadre, une navigation hors du port des artefacts ne part
  // jamais. La page du cockpit pose `frame-src` vers ce seul port (D166), et le navigateur l'applique à
  // chaque navigation du cadre, pas seulement au premier chargement. Le cadre finit sur une page d'erreur.
  for (const nom of ['vers-api.html', 'vers-dehors.html', 'rafraichir.html']) {
    test(`D166 : dans le cadre, ${nom} ne sort pas (frame-src du cockpit)`, async () => {
      const avant = recues.length;
      let versApi = 0;
      const compter = (q: { url: () => string }) => {
        if (q.url() === `${base}/api/state`) versApi += 1;
      };
      page.on('request', compter);
      await ouvrirArtefact(nom);
      // la page d'erreur du cadre, ou le cadre déjà fermé par son second load
      await expect
        .poll(
          async () =>
            page.frames().some((f) => f.url().startsWith('chrome-error://')) ||
            (await node(page, '1-3.artefacts.ferme').count()) > 0,
        )
        .toBe(true);
      page.off('request', compter);
      expect(recues.slice(avant)).toEqual([]);
      expect(versApi).toBe(0);
      if (nom === 'rafraichir.html') {
        // le refresh part après le premier load : le second load ferme le cadre (D167)
        await expect(node(page, '1-3.artefacts.ferme')).toHaveText(
          'L’artefact a quitté sa page : cadre fermé. Recharger pour le rouvrir.',
        );
      } else {
        // limite épinglée de D167 : un script qui navigue avant la fin du chargement ne laisse qu'un
        // load, le cadre reste ouvert sur la page d'erreur. Sans effet ici, puisque rien n'est sorti.
        await expect(node(page, '1-3.artefacts.cadre')).toBeVisible();
      }
    });
  }

  /** Le lien « Ouvrir à part » de l'artefact choisi : l'enveloppe (30.9, lab DM 91283). */
  async function lienAPart(nom: string): Promise<string> {
    await ouvrirArtefact(nom);
    const href = await page.getByRole('link', { name: 'Ouvrir à part' }).getAttribute('href');
    expect(href).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${PORT + 10}/v/`));
    return href!;
  }

  async function ouvrirSeule(href: string): Promise<Page> {
    const seule = await page.context().newPage();
    void seule.goto(href).catch(() => undefined);
    return seule;
  }

  // 30.9 : à part, l'artefact est de nouveau un cadre, dans l'enveloppe ; frame-src 'self' de l'enveloppe
  // arrête ses navigations comme le fait le cockpit (mesuré sous Chromium ; WebKit : recette).
  test('30.9 : à part, dans l’enveloppe, aucune navigation ne sort', async () => {
    for (const nom of ['vers-dehors.html', 'rafraichir.html', 'vers-api.html']) {
      const avant = recues.length;
      let versApi = 0;
      const seule = await ouvrirSeule(await lienAPart(nom));
      seule.on('request', (q) => {
        if (q.url() === `${base}/api/state`) versApi += 1;
      });
      await expect
        .poll(() => seule.frames().some((f) => f.url().startsWith('chrome-error://')), {
          message: nom,
        })
        .toBe(true);
      expect(recues.slice(avant), nom).toEqual([]);
      expect(versApi, nom).toBe(0);
      expect(seule.url(), nom).toContain('/v/');
      await seule.close();
    }
  });

  // La limite connue, épinglée et non cachée (D169) : l'artefact seul, par son URL directe /a/, en
  // page de premier niveau. Plus aucun bouton n'y mène, mais l'URL existe : une navigation y sort.
  test('limite connue, l’URL directe /a/ : location.href et meta refresh atteignent l’extérieur', async () => {
    for (const [nom, chemin] of [
      ['vers-dehors.html', '/navigation'],
      ['rafraichir.html', '/refresh'],
    ] as const) {
      const seule = await ouvrirSeule((await lienAPart(nom)).replace('/v/', '/a/'));
      await expect.poll(() => recues.includes(chemin), { message: nom }).toBe(true);
      await seule.close();
    }
  });

  test('D165, l’URL directe /a/ : une navigation vers l’API du daemon est refusée, jamais l’état', async () => {
    const href = (await lienAPart('vers-api.html')).replace('/v/', '/a/');
    const seule = await page.context().newPage();
    const navigation = seule.waitForResponse(
      (r) => r.url() === `${base}/api/state` && r.request().isNavigationRequest(),
    );
    void seule.goto(href).catch(() => undefined);
    const r = await navigation;
    const entetes = await r.request().allHeaders();
    // Mesuré sous Chromium : 401. Le cookie est SameSite=Strict, une navigation venue d'une origine
    // opaque ne le porte pas ; s'il passait, la règle de D165 (30.8) vaudrait 403.
    expect(entetes['sec-fetch-site']).toBe('cross-site');
    expect(entetes.cookie).toBeUndefined();
    expect(r.status()).toBe(401);
    expect(await r.text()).not.toContain('"topics"');
    await seule.close();
  });

  test('D163 : Recharger rouvre le cadre sur un nouveau lien ; Ouvrir à part pointe le même', async () => {
    await ouvrirArtefact('schema.svg');
    const src1 = await node(page, '1-3.artefacts.cadre').getAttribute('src');
    await page.getByRole('button', { name: 'Recharger' }).click();
    await expect(node(page, '1-3.artefacts.cadre')).not.toHaveAttribute('src', src1!);
    const src2 = await node(page, '1-3.artefacts.cadre').getAttribute('src');
    const aPart = page.getByRole('link', { name: 'Ouvrir à part' });
    await expect(aPart).toHaveAttribute('href', src2!.replace('/a/', '/v/'));
    await expect(aPart).toHaveAttribute('rel', 'noopener noreferrer');
    // le premier lien reste valable dans sa fenêtre (D163), et ne sert jamais l'API
    const reponse = await page.request.get(src1!);
    expect(reponse.status()).toBe(200);
    expect(reponse.headers()['content-security-policy']).toMatch(/^sandbox allow-scripts; /);
    expect(reponse.headers()['set-cookie']).toBeUndefined();
    const api = await page.request.get(`http://127.0.0.1:${PORT + 10}/api/state`);
    expect(api.status()).toBe(404);
  });

  test('Ouvrir à part : l’enveloppe, l’artefact dans son cadre garde l’origine opaque', async () => {
    const [onglet] = await Promise.all([
      page.context().waitForEvent('page'),
      (async () => {
        await ouvrirArtefact('verdict.html');
        await page.getByRole('link', { name: 'Ouvrir à part' }).click();
      })(),
    ]);
    const titre = async () => {
      const f = onglet.frames().find((x) => x.url().includes('/a/'));
      return f ? f.title() : '';
    };
    await expect.poll(titre, { timeout: 15_000 }).toMatch(/^verdict /);
    const verdict = JSON.parse((await titre()).slice('verdict '.length)) as Record<string, string>;
    expect(verdict.localStorage).toBe('SecurityError');
    expect(verdict.api).toBe('TypeError');
    expect(verdict.tauri).toBe('undefined');
    // l'enveloppe elle-même : aucun script, le cadre seul
    expect(await onglet.locator('script').count()).toBe(0);
    await expect(onglet.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts');
    await onglet.close();
  });
});
