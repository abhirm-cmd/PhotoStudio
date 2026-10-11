import { build } from 'esbuild';
const common = { bundle: true, platform: 'node', target: 'node22', format: 'cjs', sourcemap: true, outdir: 'dist-electron', outExtension: { '.js': '.cjs' }, external: ['electron', 'ffmpeg-static', '@ffprobe-installer/ffprobe'], logLevel: 'info' };
await build({ ...common, entryPoints: { main: 'electron/main.ts', preload: 'electron/preload.ts' } });
