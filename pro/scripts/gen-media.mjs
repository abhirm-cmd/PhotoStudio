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

/* An already edited reference for Match Edit: five shots with known cuts at 2.0 and 4.0 s, a 0.6 s dissolve
   starting at 5.4 s, a dip to black at 8.4 s, a fade in and a fade out, a 1.3x zoom-in anchored at the top-left corner (shot 2) and a pan (shot 4). */
run(['-f', 'lavfi', '-i', 'mandelbrot=s=1600x900', '-frames:v', '1'], 'tex-a.png');
run(['-f', 'lavfi', '-i', 'testsrc=s=1600x900:r=1', '-frames:v', '1'], 'tex-b.png');
const norm = 'fps=30,format=yuv420p,setsar=1';
run([
  '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=2',
  '-loop', '1', '-framerate', '30', '-t', '2', '-i', path.join(out, 'tex-a.png'),
  '-f', 'lavfi', '-t', '2', '-i', 'life=s=1280x720:r=30:mold=10:ratio=0.3:death_color=#202060:life_color=#ffcc00:seed=7',
  '-loop', '1', '-framerate', '30', '-t', '3', '-i', path.join(out, 'tex-b.png'),
  '-f', 'lavfi', '-i', 'testsrc=s=1280x720:r=30:d=3',
  '-f', 'lavfi', '-i', 'sine=f=523:r=48000:d=11.4,volume=0.5',
  '-filter_complex', [
    `[0:v]${norm},fade=t=in:st=0:d=0.5[s1]`,
    `[1:v]scale=w='2*ceil(1280*(1+0.3*t/2)/2)':h='2*ceil(720*(1+0.3*t/2)/2)':eval=frame,crop=1280:720:x=0:y=0,${norm}[s2]`,
    `[2:v]${norm}[s3]`,
    `[3:v]crop=1280:720:x='320*t/3':y=90,${norm},fade=t=out:st=2.6:d=0.4[s4]`,
    `[4:v]${norm},fade=t=in:st=0:d=0.4,fade=t=out:st=2.5:d=0.5[s5]`,
    '[s3][s4]xfade=transition=fade:duration=0.6:offset=1.4[x34]',
    '[s1][s2][x34][s5]concat=n=4:v=1:a=0[v]',
  ].join(';'),
  '-map', '[v]', '-map', '5:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '16', '-c:a', 'aac', '-shortest'], 'reference-edit.mp4');
