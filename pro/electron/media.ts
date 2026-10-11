/** Media analysis with FFprobe/FFmpeg: metadata, filmstrip thumbnails, waveform peaks. */
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';
import type { MediaItem, MediaKind } from '../src/shared/project';

const unpacked = (p: string | null | undefined) => (p ? p.replace('app.asar', 'app.asar.unpacked') : '');
const pick = (env: string, bundled: string, fallback: string) =>
  process.env[env] && fs.existsSync(process.env[env]!) ? process.env[env]! : bundled && fs.existsSync(bundled) ? bundled : fallback;
export const FFMPEG = pick('PHOTOSTUDIO_FFMPEG', unpacked(ffmpegStatic as unknown as string), 'ffmpeg');
export const FFPROBE = pick('PHOTOSTUDIO_FFPROBE', unpacked(ffprobeInstaller?.path), 'ffprobe');

export const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'tif', 'tiff', 'gif'];
export const VIDEO_EXT = ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'mts', 'm2ts', 'mxf', 'mpg', 'mpeg', '3gp', 'wmv', 'flv'];
export const AUDIO_EXT = ['mp3', 'wav', 'aac', 'm4a', 'flac', 'ogg', 'opus', 'aif', 'aiff', 'wma'];
export const MEDIA_EXT = [...VIDEO_EXT, ...AUDIO_EXT, ...IMAGE_EXT];

function run(bin: string, args: string[], opts: { maxBuffer?: number; encoding?: BufferEncoding | 'buffer' } = {}): Promise<{ stdout: any; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024, encoding: (opts.encoding ?? 'utf8') as any, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr: String(stderr) })); else resolve({ stdout, stderr: String(stderr) });
    });
  });
}

const rate = (r?: string) => { if (!r) return 0; const [a, b] = r.split('/').map(Number); return b ? a / b : a; };

export async function probe(file: string): Promise<Omit<MediaItem, 'id' | 'importedAt'>> {
  const { stdout } = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const j = JSON.parse(stdout);
  const streams: any[] = j.streams ?? [];
  const ext = path.extname(file).slice(1).toLowerCase();
  const v = streams.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const a = streams.find(s => s.codec_type === 'audio');
  const isImage = IMAGE_EXT.includes(ext) || (v && ['png', 'mjpeg', 'webp', 'bmp', 'tiff', 'gif'].includes(v.codec_name) && (!j.format?.duration || Number(j.format.duration) < 0.1 || IMAGE_EXT.includes(ext)));
  if (!v && !a) throw new Error('No video or audio streams found.');
  let rotation = 0;
  const sd = v?.side_data_list?.find((d: any) => d.rotation != null);
  if (sd) rotation = ((-Number(sd.rotation) % 360) + 360) % 360;
  else if (v?.tags?.rotate) rotation = Number(v.tags.rotate) % 360;
  let width = Number(v?.width ?? 0), height = Number(v?.height ?? 0);
  const sar = v?.sample_aspect_ratio && v.sample_aspect_ratio !== '0:1' ? rate(v.sample_aspect_ratio.replace(':', '/')) : 1;
  if (sar && sar !== 1) width = Math.round(width * sar);
  if (rotation === 90 || rotation === 270) [width, height] = [height, width];
  const kind: MediaKind = isImage ? 'image' : v ? 'video' : 'audio';
  const duration = isImage ? 0 : Number(j.format?.duration ?? v?.duration ?? a?.duration ?? 0);
  return {
    path: file, name: path.basename(file), kind, duration, width, height,
    fps: v ? rate(v.avg_frame_rate) || rate(v.r_frame_rate) || 30 : 0,
    hasVideo: !!v && !isImage, hasAudio: !!a && !isImage,
    videoCodec: v?.codec_name, audioCodec: a?.codec_name, channels: a?.channels, sampleRate: a ? Number(a.sample_rate) : undefined,
    rotation, colorSpace: v?.color_space, size: Number(j.format?.size ?? fs.statSync(file).size),
  };
}

export const cacheKey = (file: string, extra = '') => {
  const st = fs.statSync(file);
  return crypto.createHash('sha1').update(`${file}|${st.size}|${st.mtimeMs}|${extra}`).digest('hex').slice(0, 20);
};

export const THUMB_H = 72;

/** One horizontal JPEG sprite of evenly spaced frames, used for timeline filmstrips and bin posters. */
export async function makeThumbs(m: MediaItem, dir: string): Promise<NonNullable<MediaItem['thumbs']>> {
  const key = `${cacheKey(m.path, 'thumbs4')}.jpg`;
  const out = path.join(dir, key);
  const aspect = m.width && m.height ? m.width / m.height : 16 / 9;
  const w = Math.max(2, Math.round((THUMB_H * aspect) / 2) * 2);
  if (m.kind === 'image') {
    if (!fs.existsSync(out)) await run(FFMPEG, ['-v', 'error', '-y', '-i', m.path, '-vf', `scale=${w}:${THUMB_H}`, '-frames:v', '1', out]);
    return { key, count: 1, interval: 0, width: w, height: THUMB_H };
  }
  const count = Math.max(1, Math.min(160, Math.ceil(m.duration / 0.5)));
  const interval = m.duration / count;
  if (!fs.existsSync(out)) {
    // Decode every frame: keyframe-only decoding repeats one picture (or yields nothing) on long-GOP footage
    await run(FFMPEG, ['-v', 'error', '-y', '-threads', '0', '-i', m.path, '-an', '-sn', '-vf', `fps=${(1 / interval).toFixed(6)},scale=${w}:${THUMB_H},tile=${count}x1`, '-frames:v', '1', '-q:v', '5', out]);
    if (!fs.existsSync(out)) throw new Error('No frames could be decoded for the filmstrip.');
  }
  return { key, count, interval, width: w, height: THUMB_H };
}

export const WAVE_RATE = 100; // peaks per second

/** Peak envelope (0–255 per 10 ms) of the mixed-down audio. */
export function makeWaveform(m: MediaItem, dir: string): Promise<NonNullable<MediaItem['waveform']>> {
  const key = `${cacheKey(m.path, 'wave1')}.bin`;
  const out = path.join(dir, key);
  if (fs.existsSync(out)) return Promise.resolve({ key, rate: WAVE_RATE });
  return new Promise((resolve, reject) => {
    const sr = 8000, per = sr / WAVE_RATE;
    const proc = spawn(FFMPEG, ['-v', 'error', '-i', m.path, '-vn', '-ac', '1', '-ar', String(sr), '-f', 'f32le', 'pipe:1'], { windowsHide: true });
    const peaks: number[] = [];
    let acc = 0, n = 0, rest: Buffer = Buffer.alloc(0);
    proc.stdout.on('data', (chunk: Buffer) => {
      const buf = rest.length ? Buffer.concat([rest, chunk]) : chunk;
      const len = buf.length - (buf.length % 4);
      for (let i = 0; i < len; i += 4) {
        const v = Math.abs(buf.readFloatLE(i));
        if (v > acc) acc = v;
        if (++n >= per) { peaks.push(acc); acc = 0; n = 0; }
      }
      rest = Buffer.from(buf.subarray(len));
    });
    let err = '';
    proc.stderr.on('data', d => { err += d; });
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(err || `ffmpeg exited with ${code}`));
      if (n) peaks.push(acc);
      const bytes = Buffer.from(peaks.map(v => Math.min(255, Math.round(Math.sqrt(Math.min(1, v)) * 255))));
      fs.writeFileSync(out, bytes);
      resolve({ key, rate: WAVE_RATE });
    });
  });
}

/** A single decoded frame as JPEG (used for poster frames and still exports). */
export async function grabFrame(file: string, t: number, out: string) {
  await run(FFMPEG, ['-v', 'error', '-y', '-ss', String(Math.max(0, t)), '-i', file, '-frames:v', '1', '-q:v', '2', out]);
  return out;
}

/** A 720p H.264 proxy for smooth preview of formats Chromium can't play. Exports always read the original. */
export function makeProxy(m: MediaItem, dir: string, onProgress?: (f: number) => void): Promise<string> {
  const key = `${cacheKey(m.path, 'proxy1')}.mp4`;
  const out = path.join(dir, key);
  if (fs.existsSync(out)) return Promise.resolve(key);
  const tmp = `${out}.part.mp4`;
  return new Promise((resolve, reject) => {
    const args = ['-v', 'error', '-y', '-i', m.path, '-map', '0:v:0', '-map', '0:a:0?', '-vf', "scale=-2:'min(720,ih)':flags=bicubic,format=yuv420p",
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-g', '15', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-progress', 'pipe:1', tmp];
    const proc = spawn(FFMPEG, args, { windowsHide: true });
    let err = '';
    proc.stdout.on('data', d => { const mm = /out_time_us=(\d+)/.exec(String(d)); if (mm && m.duration) onProgress?.(Math.min(1, Number(mm[1]) / 1e6 / m.duration)); });
    proc.stderr.on('data', d => { err += d; });
    proc.on('close', code => {
      if (code !== 0) { fs.rmSync(tmp, { force: true }); return reject(new Error(err.trim().split('\n').pop() || `ffmpeg exited with ${code}`)); }
      fs.renameSync(tmp, out);
      resolve(key);
    });
  });
}
