// Locates the bundled FFmpeg / FFprobe binaries (works from source, tests and packaged builds).
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const unpacked = p => (p ? p.replace('app.asar', 'app.asar.unpacked') : p);
const pick = (env, bundled, fallback) => {
  if (process.env[env] && fs.existsSync(process.env[env])) return process.env[env];
  try { const p = unpacked(bundled()); if (p && fs.existsSync(p)) return p; } catch { /* not installed */ }
  return fallback;
};

export const ffmpegPath = () => pick('PHOTOSTUDIO_FFMPEG', () => require('ffmpeg-static'), 'ffmpeg');
export const ffprobePath = () => pick('PHOTOSTUDIO_FFPROBE', () => require('@ffprobe-installer/ffprobe').path, 'ffprobe');
