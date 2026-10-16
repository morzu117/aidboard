import { expect, test } from '@playwright/test';
import {
  createTopic,
  launchShell,
  newRepo,
  node,
  openApp,
  registerWorkspace,
  terminalText,
  typeInTerminal,
} from './helpers.js';

// La maquette définit déjà .terminal (boîte de 128 px) : xterm pose la même classe sur sa racine et se retrouvait écrasé.
for (const [width, height] of [
  [1600, 800],
  [1280, 720],
] as const) {
  test(`le terminal remplit sa zone et le PTY a la même taille (${width}×${height})`, async ({
    browser,
  }) => {
    const page = await openApp(await browser.newContext({ viewport: { width, height } }));
    await registerWorkspace(page, newRepo(`depot-affichage-${width}`));
    await createTopic(page, `Affichage ${width}`);
    const agent = await launchShell(page);

    const geometry = () =>
      page.evaluate((id) => {
        const host = document.querySelector('.sortie-xterm') as HTMLElement;
        const root = host.querySelector('.xterm') as HTMLElement;
        const term = (
          window as unknown as { __aidTerminals: Record<string, { cols: number; rows: number }> }
        ).__aidTerminals[id]!;
        return {
          hostHeight: host.clientHeight,
          rootHeight: root.clientHeight,
          rows: term.rows,
          cols: term.cols,
          pageWidth: document.documentElement.scrollWidth,
          windowWidth: innerWidth,
        };
      }, agent);

    // le terminal occupe la hauteur de sa zone (à une demi-ligne près), pas les 128 px de la maquette
    await expect.poll(async () => (await geometry()).rootHeight).toBeGreaterThan(300);
    const g = await geometry();
    expect(g.rootHeight).toBeGreaterThanOrEqual(g.hostHeight - 20);
    expect(g.rows).toBeGreaterThan(20);
    expect(g.pageWidth).toBeLessThanOrEqual(g.windowWidth);

    // le PTY connaît la taille réellement affichée, et le pied de terminal l'affiche
    await typeInTerminal(page, 'stty size');
    await expect
      .poll(() => terminalText(page, agent), { timeout: 15_000 })
      .toContain(`${g.rows} ${g.cols}`);
    await expect(node(page, '1-3.terminaux.pied.taille')).toContainText(`${g.cols}×${g.rows}`);
  });
}
