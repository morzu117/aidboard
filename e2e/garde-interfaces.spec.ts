import { readFileSync } from 'node:fs';
import { test, expect } from './test.js';
import { fichierClics } from './releves.js';

test('D345 : clics conservés après navigation et fermeture de contextes manuels', async ({
  browser,
}) => {
  const contexte = await browser.newContext();
  const page = await contexte.newPage();
  await page.goto(
    'data:text/html,<a data-node="preuve.navigation" href="about:blank"><span data-node="preuve.libelle">Partir</span></a>',
  );
  await page.locator('span').click();
  await page.waitForURL('about:blank');
  await page.goto(
    'data:text/html,<button data-node="preuve.fermeture">Fermer</button><button>Sans identifiant</button>',
  );
  await page.getByText('Fermer').click();
  await page.getByText('Sans identifiant').click();
  await contexte.close();
  const clics = readFileSync(fichierClics(), 'utf8')
    .trim()
    .split('\n')
    .map((ligne) => JSON.parse(ligne));
  expect(clics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        node: 'preuve.libelle',
        action: 'preuve.navigation',
        element: 'span',
      }),
      expect.objectContaining({
        node: 'preuve.fermeture',
        action: 'preuve.fermeture',
        element: 'button',
      }),
      expect.objectContaining({ node: null, element: expect.stringContaining('button') }),
    ]),
  );
});

test.describe('D345 : contexte créé avant les tests', () => {
  let page: import('@playwright/test').Page;
  test.beforeAll(async ({ browser }) => {
    const contexte = await browser.newContext();
    page = await contexte.newPage();
    await page.goto('data:text/html,<button data-node="preuve.before-all">Action</button>');
  });
  test.afterAll(async () => {
    await page.context().close();
  });
  test('le contexte de beforeAll reçoit aussi le script de capture', async () => {
    await page.getByText('Action').click();
    expect(readFileSync(fichierClics(), 'utf8')).toContain('"node":"preuve.before-all"');
  });
});
