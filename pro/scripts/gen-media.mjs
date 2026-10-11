/**
 * Generates test media with FFmpeg into tests/media (no third-party footage needed):
 * HD and 720p clips with tone audio, a portrait phone-style clip, a still and a music bed.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ffmpegPath } from '../electron/ffpaths.mjs';

const out = path.resolve(import.meta.dirname, '..', 'tests', 'media');
fs.mkdirSync(out, { recursive: true });
const run = (args, name) => {
  const f = path.join(out, name);
  if (fs.existsSync(f)) return;
  execFileSync(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', ...args, f]);
  console.log('wrote', path.relative(process.cwd(), f));
};

run(['-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=30:d=10', '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=10',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '20', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-c:a', 'aac', '-b:a', '160k', '-shortest'], 'city-1080p30.mp4');
run(['-f', 'lavfi', '-i', 'smptehdbars=s=1280x720:r=25:d=6', '-f', 'lavfi', '-i', 'sine=f=660:r=48000:d=6',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-c:a', 'aac', '-shortest'], 'bars-720p25.mp4');
run(['-f', 'lavfi', '-i', 'mandelbrot=s=720x1280:r=30', '-t', '5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast'], 'vertical-720x1280.mp4');
run(['-f', 'lavfi', '-i', 'gradients=s=1600x1200:d=1:speed=0', '-frames:v', '1'], 'still-gradient.png');
run(['-f', 'lavfi', '-i', 'sine=f=220:r=48000:d=20,volume=0.4', '-f', 'lavfi', '-i', 'sine=f=330:r=48000:d=20,volume=0.3', '-filter_complex', 'amix=inputs=2', '-c:a', 'libmp3lame', '-b:a', '192k'], 'music-bed.mp3');
