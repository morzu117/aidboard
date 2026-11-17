import { test as base } from '@playwright/test';
import { optionsNavigateur, preparerAudit } from './environnement.js';

// Un timeout du corps laisse un budget propre au teardown, qui libère les processus.
export const test = base.extend<{ audit: Awaited<ReturnType<typeof preparerAudit>> }>({
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
test.use({ launchOptions: optionsNavigateur });
