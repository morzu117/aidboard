import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const daemon = 'http://127.0.0.1:4870';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // changeOrigin : sans lui le daemon reçoit « Host: 127.0.0.1:5173 » et répond 421
    proxy: {
      '/api': { target: daemon, changeOrigin: true },
      '/auth': { target: daemon, changeOrigin: true },
      '/ws': { target: daemon, changeOrigin: true, ws: true },
    },
  },
  build: { outDir: '../dist/web', emptyOutDir: true },
});
