import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@shared': path.resolve(__dirname, '../shared/types'),
      // Canonical crew/transport calculator engine. Single source of truth shared
      // with the backend (which owns the file) so the modal display === the saved /
      // HireHop-pushed figure. The file is pure TS with no backend-only imports.
      '@calc': path.resolve(__dirname, '../backend/src/services/crew-transport-calculator.ts'),
    },
  },
  server: {
    port: 5173,
    // Allow Vite's dev server to read the shared engine from ../backend (outside frontend root).
    fs: {
      allow: [path.resolve(__dirname, '..')],
    },
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/socket.io': {
        target: 'http://localhost:3001',
        ws: true,
      },
    },
  },
});
