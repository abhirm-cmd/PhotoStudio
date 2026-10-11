import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const dir = import.meta.dirname;
export default defineConfig({
  root: path.resolve(dir, 'src/renderer'),
  base: './',
  plugins: [react()],
  resolve: { alias: { '@shared': path.resolve(dir, 'src/shared') } },
  server: { port: 5183, strictPort: true, fs: { allow: [path.resolve(dir), path.resolve(dir, '..')] } },
  build: { outDir: path.resolve(dir, 'dist'), emptyOutDir: true, target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 4000 },
  test: { root: dir, include: ['tests/unit/**/*.test.ts'], environment: 'node', testTimeout: 120000 },
} as any);
