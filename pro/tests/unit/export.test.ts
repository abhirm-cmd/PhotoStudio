import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newProject, newClip, uid, type Project, type MediaItem } from '@shared/project';
import { clipsForMedia, placeClips } from '@shared/timeline';
import { buildExport } from '@shared/ffgraph';
import { bakeLut, defaultGrade, writeCube } from '@shared/grade';
import { probe, FFMPEG, FFPROBE } from '../../electron/media';

const MEDIA = path.resolve(__dirname, '..', 'media');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'psp-export-'));
const media: Record<string, MediaItem> = {};

beforeAll(async () => {
  if (!fs.existsSync(path.join(MEDIA, 'city-1080p30.mp4'))) execFileSync(process.execPath, [path.resolve(__dirname, '..', '..', 'scripts', 'gen-media.mjs')]);
  for (const f of ['city-1080p30.mp4', 'bars-720p25.mp4', 'vertical-720x1280.mp4', 'still-gradient.png', 'music-bed.mp3'])
    media[f] = { ...(await probe(path.join(MEDIA, f))), id: uid('m'), importedAt: new Date().toISOString() };
});

const add = (p: Project, name: string, start: number, opts: Parameters<typeof clipsForMedia>[3] = {}) => {
  if (!p.media.find(m => m.name === name)) p.media.push(media[name]);
  const cs = clipsForMedia(p, media[name].id, start, opts);
  placeClips(p, cs);
  return cs;
};

function run(p: Project, format: 'h264' | 'prores' | 'wav', assets = { luts: {}, titles: {} }, extra: object = {}) {
  const out = path.join(OUT, `${uid('o')}.${format === 'prores' ? 'mov' : format === 'wav' ? 'wav' : 'mp4'}`);
  const cmd = buildExport(p, { format, output: out, ...extra }, assets);
  try { execFileSync(FFMPEG, cmd.args.map(a => (a === 'pipe:1' ? 'pipe:1' : a)), { stdio: ['ignore', 'ignore', 'pipe'] }); }
  catch (e: any) { throw new Error(`${e.stderr}\n--- graph ---\n${cmd.graph}`); }
  const info = JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', out]).toString());
  return { out, info, cmd };
}

/** Average RGB of one output frame at `t` seconds. */
function frameRgb(file: string, t: number, crop?: string) {
  const vf = [crop ? `crop=${crop}` : '', 'scale=1:1:flags=area', 'format=rgb24'].filter(Boolean).join(',');
  const buf = execFileSync(FFMPEG, ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', vf, '-f', 'rawvideo', 'pipe:1']);
  return [buf[0], buf[1], buf[2]];
}

/** Peak volume (dB) of a time range. */
function peakDb(file: string, from: number, dur: number) {
  const r = require('node:child_process').spawnSync(FFMPEG, ['-hide_banner', '-ss', String(from), '-t', String(dur), '-i', file, '-af', 'volumedetect', '-vn', '-f', 'null', '-']);
  const m = /max_volume: (-?[\d.]+|-inf) dB/.exec(String(r.stderr));
  return m ? (m[1] === '-inf' ? -Infinity : Number(m[1])) : NaN;
}

describe('export (real FFmpeg)', () => {
  it('cuts two clips with a dissolve, a portrait clip and a still into an H.264 file of the right length', () => {
    const p = newProject('t');
    add(p, 'city-1080p30.mp4', 0, { srcIn: 1, srcOut: 4 });              // 90 frames
    const [b] = add(p, 'bars-720p25.mp4', 90, { srcIn: 0, srcOut: 3 });   // 90 frames
    b.transitionIn = { type: 'dissolve', duration: 15 };
    add(p, 'vertical-720x1280.mp4', 180, { srcOut: 2 });                  // pillarboxed portrait
    add(p, 'still-gradient.png', 240, { imageSeconds: 1 });
    const { info, cmd } = run(p, 'h264');
    expect(cmd.duration).toBeCloseTo(270 / 30, 5);
    const v = info.streams.find((s: any) => s.codec_type === 'video');
    const a = info.streams.find((s: any) => s.codec_type === 'audio');
    expect(v.codec_name).toBe('h264');
    expect([v.width, v.height]).toEqual([1920, 1080]);
    expect(v.color_primaries).toBe('bt709');
    expect(a.codec_name).toBe('aac');
    expect(Math.abs(Number(info.format.duration) - 9)).toBeLessThan(0.12);
  });

  it('pillarboxes portrait footage with black bars and keeps the picture centered', () => {
    const p = newProject('t');
    add(p, 'vertical-720x1280.mp4', 0, { srcOut: 1 });
    const { out } = run(p, 'h264');
    const bar = frameRgb(out, 0.5, '200:1080:0:0');
    expect(Math.max(...bar)).toBeLessThan(6);
    const centre = frameRgb(out, 0.5, '400:400:760:340');
    expect(Math.max(...centre)).toBeGreaterThan(20);
  });

  it('applies a baked grade LUT (exposure up = brighter, desaturated = grey)', () => {
    const p = newProject('t');
    const [c] = add(p, 'bars-720p25.mp4', 0, { srcOut: 1 });
    const plain = run(p, 'h264');
    const g = { ...defaultGrade(), exposure: 1, saturation: 0 };
    const cube = path.join(OUT, 'g.cube');
    fs.writeFileSync(cube, writeCube(bakeLut(g)));
    const graded = run(p, 'h264', { luts: { [c.id]: cube }, titles: {} });
    const region = '300:300:200:100';
    const a = frameRgb(plain.out, 0.4, region), b = frameRgb(graded.out, 0.4, region);
    expect(b[0] + b[1] + b[2]).toBeGreaterThan(a[0] + a[1] + a[2]);
    expect(Math.max(...b) - Math.min(...b)).toBeLessThan(6);
  });

  it('honours opacity, transform and fades to black', () => {
    const p = newProject('t');
    const [c] = add(p, 'city-1080p30.mp4', 0, { srcOut: 2 });
    c.fadeIn = 15; c.fadeOut = 15;
    c.transform = { ...c.transform, scale: 0.5, x: 400 };
    const { out } = run(p, 'h264');
    expect(Math.max(...frameRgb(out, 0))).toBeLessThan(8);                    // starts black
    expect(Math.max(...frameRgb(out, 1, '300:300:0:390'))).toBeLessThan(6);   // left side is empty after scaling
    expect(Math.max(...frameRgb(out, 1, '300:300:1250:390'))).toBeGreaterThan(20);
  });

  it('mixes audio with clip volume, track mute and speed changes', () => {
    const p = newProject('t');
    const cs = add(p, 'city-1080p30.mp4', 0, { srcOut: 2 });
    const a = cs.find(x => p.tracks.find(t => t.id === x.trackId)!.kind === 'audio')!;
    a.volume = -12;
    const [m] = add(p, 'music-bed.mp3', 60, { audioTrack: p.tracks.filter(t => t.kind === 'audio')[1].id, srcOut: 4 });
    m.speed = 2; m.duration = 60; // 4 s of source at 2× = 2 s
    const { out, info } = run(p, 'wav');
    expect(info.streams[0].codec_name).toBe('pcm_s24le');
    expect(Number(info.format.duration)).toBeCloseTo(4, 1);
    const tone = peakDb(out, 0.2, 1);
    expect(tone).toBeCloseTo(-30, 0); // −18 dB source tone at −12 dB clip gain
    p.tracks.find(t => t.id === a.trackId)!.muted = true;
    const muted = run(p, 'wav');
    expect(peakDb(muted.out, 0.2, 1)).toBeLessThan(-80);
  });

  it('exports a range and ProRes', () => {
    const p = newProject('t', { width: 1280, height: 720, fps: 25 });
    add(p, 'bars-720p25.mp4', 0);
    const { info } = run(p, 'prores', undefined, { from: 25, to: 75 });
    const v = info.streams.find((s: any) => s.codec_type === 'video');
    expect(v.codec_name).toBe('prores');
    expect(v.pix_fmt).toBe('yuv422p10le');
    expect(Number(info.format.duration)).toBeCloseTo(2, 1);
  });
});
