import { test as base } from './test.js';
import { optionsNavigateur, preparerAudit } from './audit/environnement.js';

// Les essais d'audit du gate héritent du garde ; l'audit complet garde sa fixture.
// Une option de fixture évite les effets de test.use() à l'import d'un helper.
export const test = base.extend<{ audit: Awaited<ReturnType<typeof preparerAudit>> }>({
  launchOptions: [optionsNavigateur, { scope: 'worker' }],
  audit: [
    async ({ browser }, utiliser) => {
      const environnement = await preparerAudit(browser);
      try {
        await utiliser(environnement);
      } finally {
        await environnement.fermer();
      }
    },
    { timeout: 60_000 },
  ],
});
