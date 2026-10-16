import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { 'cli/aid': 'src/cli/aid.ts' },
  format: 'esm',
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: false,
  sourcemap: true,
  external: ['node-pty', 'better-sqlite3'],
});
