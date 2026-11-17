import { appendFileSync } from 'node:fs';
import { test as base, expect, type Page, type Browser } from '@playwright/test';
import { normaliserNode } from './normaliser-node.js';
import { fichierClics, fichierVisuel } from './releves.js';
import { detecterVisuel } from './visuel.js';

export { expect };
export type * from '@playwright/test';

const verifications = new Map<Browser, (page: Page) => Promise<void>>();

export const test = base.extend<{ gardeInterfaces: void }, { browser: Browser }>({
  browser: [
    async ({ browser }, utiliser) => {
      const nouveauContexte = browser.newContext.bind(browser);
      browser.newContext = async (...argumentsContexte) => {
        const contexte = await nouveauContexte(...argumentsContexte);
        await contexte.exposeBinding(
          '__aidClic',
          (_source, clic: { node: string | null; action: string | null; element: string }) => {
            // Écriture immédiate côté Node : indépendante du document et de sa fermeture.
            appendFileSync(
              fichierClics(),
              `${JSON.stringify({ ...clic, node: clic.node ? normaliserNode(clic.node) : null, action: clic.action ? normaliserNode(clic.action) : null })}\n`,
            );
          },
        );
        await contexte.addInitScript(() => {
          document.addEventListener(
            'click',
            (evenement) => {
              const cible = evenement.target instanceof Element ? evenement.target : null;
              if (!cible) return;
              const node = cible.closest('[data-node]')?.getAttribute('data-node') ?? null;
              const action =
                cible
                  .closest('button, a[href], [role=button], summary, input, select, textarea')
                  ?.getAttribute('data-node') ?? null;
              const transmettre = (
                globalThis as unknown as {
                  __aidClic: (clic: {
                    node: string | null;
                    action: string | null;
                    element: string;
                  }) => Promise<void>;
                }
              ).__aidClic;
              const chemin = (element: Element): string => {
                const balise = element.tagName.toLowerCase();
                const parent = element.parentElement;
                if (!parent) return balise;
                return `${chemin(parent)} > ${balise}:nth-child(${[...parent.children].indexOf(element) + 1})`;
              };
              void transmettre({
                node,
                action,
                element: node ? cible.tagName.toLowerCase() : chemin(cible),
              });
            },
            true,
          );
        });
        contexte.on('page', (page) => {
          const fermer = page.close.bind(page);
          page.close = async (...options) => {
            try {
              await verifications.get(browser)?.(page);
            } finally {
              await fermer(...options);
            }
          };
        });
        const fermer = contexte.close.bind(contexte);
        contexte.close = async (...options) => {
          try {
            for (const page of contexte.pages()) await verifications.get(browser)?.(page);
          } finally {
            await fermer(...options);
          }
        };
        return contexte;
      };
      try {
        await utiliser(browser);
      } finally {
        browser.newContext = nouveauContexte;
      }
    },
    { scope: 'worker' },
  ],
  gardeInterfaces: [
    async ({ browser }, utiliser, info) => {
      const relevesDuTest: unknown[] = [];
      const verifier = async (page: Page) => {
        if (page.isClosed() || !/^https?:/.test(page.url())) return;
        // Les trois apps chargent un bundle ; une page setContent n'en charge aucun.
        if (!(await page.locator('script[type="module"][src]').count())) return;
        const trouvailles = await detecterVisuel(page);
        const releve = {
          test: info.titlePath.join(' > '),
          ecran: new URL(page.url()).pathname,
          format: page.viewportSize(),
          trouvailles,
        };
        appendFileSync(fichierVisuel(), `${JSON.stringify(releve)}\n`);
        if (trouvailles.length) relevesDuTest.push(releve);
      };
      verifications.set(browser, verifier);
      try {
        await utiliser();
      } finally {
        try {
          for (const contexte of browser.contexts())
            for (const page of contexte.pages()) await verifier(page);
          // L'échec attend la fin du nettoyage : fermer un contexte ne doit pas
          // interrompre le finally du test avant l'arrêt de son daemon.
          if (process.env.AID_VISUEL_RELEVE !== '1')
            expect(relevesDuTest, JSON.stringify(relevesDuTest, null, 2)).toEqual([]);
        } finally {
          verifications.delete(browser);
        }
      }
    },
    { auto: true },
  ],
});
