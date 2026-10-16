import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    // node-pty plante par intermittence dans les worker threads
    pool: 'forks',
  },
});
