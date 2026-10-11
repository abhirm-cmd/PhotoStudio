// Development: Vite dev server for the renderer + esbuild watch for main/preload + Electron.
import { createServer } from 'vite';
import { context } from 'esbuild';
import { spawn } from 'node:child_process';
import path from 'node:path';
import electronPath from 'electron';

const root = path.resolve(import.meta.dirname, '..');
const server = await createServer({ configFile: path.join(root, 'vite.config.ts') });
await server.listen();
const url = server.resolvedUrls.local[0];

let child = null;
const restart = () => {
  if (child) { child.removeAllListeners('exit'); child.kill(); }
  child = spawn(electronPath, ['.'], { cwd: root, stdio: 'inherit', env: { ...process.env, PHOTOSTUDIO_PRO_DEV_URL: `${url}index.html` } });
  child.on('exit', code => { server.close(); process.exit(code ?? 0); });
};
const ctx = await context({
  bundle: true, platform: 'node', target: 'node22', format: 'cjs', sourcemap: true, outdir: path.join(root, 'dist-electron'), outExtension: { '.js': '.cjs' },
  external: ['electron', 'ffmpeg-static', '@ffprobe-installer/ffprobe'], entryPoints: { main: path.join(root, 'electron/main.ts'), preload: path.join(root, 'electron/preload.ts') },
  plugins: [{ name: 'restart', setup: b => b.onEnd(r => { if (!r.errors.length) restart(); }) }],
});
await ctx.watch();
console.log(`PhotoStudio Pro dev: renderer at ${url}`);
