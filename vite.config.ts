import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/WarZone/' : '/',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 3000,
    open: true,
  },
}));
