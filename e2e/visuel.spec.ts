import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { explorer } from './audit/explorateur.js';
import { detecterVisuel } from './visuel.js';

const cas = [
  ['bouton natif', '<button id="cible">Action</button>', 'style par défaut'],
  [
    'bordure native',
    '<button id="cible" style="background:#123;color:white">Action</button>',
    'style par défaut',
  ],
  ['case native', '<input id="cible" type="checkbox">', 'style par défaut'],
  ['lien natif', '<a id="cible" href="#">Lien</a>', 'style par défaut'],
  ['texte pâle', '<p id="cible" style="color:#eee">Texte</p>', 'contraste'],
  [
    'débordement',
    '<div id="cible" style="width:30px"><span style="white-space:nowrap">Un texte bien trop large</span></div>',
    'débordement',
  ],
  [
    'mot écrasé',
    '<p id="cible" style="width:8px;word-break:break-all">Bonjour</p>',
    'texte écrasé',
  ],
  [
    'chevauchement',
    '<div style="position:relative"><span id="cible" style="position:absolute">Premier texte</span><span style="position:absolute">Second texte</span></div>',
    'chevauchement',
  ],
] as const;
for (const [nom, contenu, regle] of cas) {
  test(`D346 détecte : ${nom}`, async ({ page }) => {
    await page.setContent(`<body style="background:white;color:black">${contenu}</body>`);
    expect(await detecterVisuel(page)).toEqual(
      expect.arrayContaining([expect.objectContaining({ selecteur: '#cible', regle })]),
    );
    await expect(page.locator('iframe')).toHaveCount(0);
  });
}
test('D346 : page propre, fonds composés, défilement et exceptions', async ({ page }) => {
  await page.setContent(`<body style="background:#fff;color:#111">
    <p>Une page lisible.</p>
    <div style="background:#000"><p style="background:rgba(255,255,255,.9)">Fond composé lisible</p></div>
    <button style="background:#173950;color:white;border:1px solid #173950">Action</button>
    <a href="#" style="color:#173950">Lien</a>
    <div style="width:80px;overflow-x:auto"><div style="width:400px">Tableau qui défile</div></div>
    <div data-visuel-exception="Cas volontaire"><button>Natif</button></div>
    <div class="xterm"><button>Natif</button></div>
  </body>`);
  expect(await detecterVisuel(page)).toEqual([]);
});
test('D346 : contraste désactivé et gros texte à 3:1', async ({ page }) => {
  await page.setContent(
    `<body style="background:white;color:black"><p style="font-size:24px;color:#888">Gros texte</p><input disabled style="background:white;color:#888;border:1px solid #123" value="Lisible"><button disabled style="background:white;color:#888;border:1px solid #123"><span>Texte désactivé</span></button><p id="cible" style="color:#888">Petit texte</p></body>`,
  );
  const contrastes = (await detecterVisuel(page)).filter((t) => t.regle === 'contraste');
  expect(contrastes).toEqual([expect.objectContaining({ selecteur: '#cible' })]);
});

for (const clair of [false, true]) {
  test(`56.8 : socle natif sur palette ${clair ? 'claire' : 'sombre'}`, async ({ page }) => {
    const css = await readFile(new URL('../web/src/styles/natifs.css', import.meta.url), 'utf8');
    const palette = clair
      ? '--text:#17212b;--muted:#536171;--surface-input:#fff;--surface-3:#edf1f5;--line:#ccd2da;--line-2:#82909f;--acc:#006b4b;--fond:#fff'
      : '--text:#e7e9ec;--muted:#9aa3af;--surface-input:#0f1215;--surface-3:#1c2128;--line:#222830;--line-2:#2e353f;--acc:#00d994;--fond:#0d0f12';
    await page.setContent(`<style>:root{${palette};--sp-2:8px;--sp-3:12px;--r-s:6px}body{background:var(--fond);color:var(--text)}${css}</style>
      <button>Action</button><input value="Texte"><select><option>Choix</option></select>
      <textarea>Texte long</textarea><input type="checkbox" aria-label="Option"><a href="#">Lien</a>
      <input disabled value="Relais désactivé"><button disabled>Action désactivée</button>`);
    expect(await detecterVisuel(page)).toEqual([]);
  });
}

test('D346 : les textes masqués par découpe ne sont pas visibles', async ({ page }) => {
  await page.setContent(
    `<body style="background:white;color:black"><p style="position:absolute;clip:rect(0,0,0,0);width:1px;height:1px;overflow:hidden;white-space:nowrap">Une indication réservée aux lecteurs d'écran</p></body>`,
  );
  expect(await detecterVisuel(page)).toEqual([]);
});

test('D346 : le rapport classe une trouvaille par vue avant les clics', async ({ page }) => {
  const dossier = await mkdtemp(join(tmpdir(), 'aid-visuel-rapport-'));
  try {
    const rapport = await explorer({
      ecrans: [
        {
          nom: 'Écran synthétique',
          chemin: 'data:text/html,<button data-node="synthetique.action">Action</button>',
          page,
        },
      ],
      dossier,
      verifierDaemon: async () => true,
      choisirElements: () => false,
    });
    expect(rapport.compteurs.visuel).toBe(2);
    expect(rapport.ecrans.every((e) => !e.erreurChargement)).toBe(true);
    expect(rapport.resultats.map((r) => [r.ecran, r.format, r.node, r.visuel?.regle])).toEqual([
      ['Écran synthétique', '1280x800', 'synthetique.action', 'style par défaut'],
      ['Écran synthétique', '390x844', 'synthetique.action', 'style par défaut'],
    ]);
    expect(await readFile(join(dossier, 'rapport.md'), 'utf8')).toContain('style par défaut');
  } finally {
    await rm(dossier, { recursive: true, force: true });
  }
});

test("D346 : contraste d'un placeholder, sans inventer du texte dans une case", async ({
  page,
}) => {
  await page.setContent(
    `<style>body{background:#111;color:white}input::placeholder{color:#222;opacity:1}</style><input id="cible" placeholder="Texte pâle" style="background:#111;color:white;border:1px solid #345"><input type="checkbox">`,
  );
  expect((await detecterVisuel(page)).filter((t) => t.regle === 'contraste')).toEqual([
    expect.objectContaining({ selecteur: '#cible' }),
  ]);
});

test('D346 : code technique pleine largeur lisible, code tassé toujours détecté', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const cle = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.repeat(2);
  await page.setContent(`<body style="background:white;color:black">
    <code id="lisible" style="display:block;width:100%;overflow-wrap:anywhere;word-break:normal">${cle}</code>
    <code id="tasse" style="display:block;width:8px;overflow-wrap:anywhere;word-break:normal">${cle}</code>
  </body>`);
  const defauts = await detecterVisuel(page);
  expect(defauts.filter((d) => d.selecteur === '#lisible')).toEqual([]);
  expect(defauts).toContainEqual(
    expect.objectContaining({ selecteur: '#tasse', regle: 'texte écrasé' }),
  );
});

test('D346 : ellipse sans faux chevauchement, recouvrement visible toujours détecté', async ({
  page,
}) => {
  await page.setContent(`<body style="background:white;color:black">
    <div style="display:flex;gap:8px;white-space:nowrap">
      <span id="cible" style="display:block;flex:none;width:100px;overflow:hidden;text-overflow:ellipsis">Un nom de serveur beaucoup plus long</span>
      <span id="voisin">Injoignable</span>
    </div>
  </body>`);
  expect(await detecterVisuel(page)).toEqual([]);
  await page.locator('#voisin').evaluate((e) => {
    e.style.transform = 'translateX(-25px)';
  });
  expect(await detecterVisuel(page)).toContainEqual(
    expect.objectContaining({ selecteur: '#cible', regle: 'chevauchement' }),
  );
});
