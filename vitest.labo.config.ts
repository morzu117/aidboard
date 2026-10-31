import { defineConfig } from 'vitest/config';

// Chantier 18 (DL6) : le labo serveur, hors du gate — il demande Docker. `npm run gate:labo`.
export default defineConfig({
  test: {
    include: ['test/labo/**/*.labo.ts'],
    globalSetup: ['test/labo/global-setup.ts'],
    pool: 'forks',
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
