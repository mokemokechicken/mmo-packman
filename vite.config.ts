import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 5173,
    watch: {
      ignored: ['**/rust/server/target/**', '**/dist/**', '**/.git/**'],
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 5173,
  },
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
  },
});
