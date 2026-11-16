import { test } from '@playwright/test';
import { optionsNavigateur, preparerAudit } from './environnement.js';
import { explorer } from './explorateur.js';

test.use({ launchOptions: optionsNavigateur });
test('audit complet des interfaces D343', async ({ browser }) => {
  const environnement = await preparerAudit(browser);
  try {
    await explorer(environnement);
  } finally {
    await environnement.fermer();
  }
});
