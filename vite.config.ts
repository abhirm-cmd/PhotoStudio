import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  root: path.resolve(import.meta.dirname, 'src/renderer'),
  publicDir: path.resolve(import.meta.dirname, 'public'),
  base: './',
  plugins: [react()],
  resolve: { alias: { '@shared': path.resolve(import.meta.dirname, 'src/shared') } },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['libheif-js'] },
  server: { port: 5173, strictPort: true, headers: isolation, fs: { allow: [path.resolve(import.meta.dirname)] } },
  preview: { headers: isolation },
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 4000,
    rollupOptions: { input: { index: path.resolve(import.meta.dirname, 'src/renderer/index.html') } },
  },
  test: { root: path.resolve(import.meta.dirname), include: ['tests/unit/**/*.test.ts'], environment: 'node' },
} as any);
