import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newProject, uid, type MediaItem, type Project } from '@shared/project';
import { buildExport } from '@shared/ffgraph';
import { bakeLut, defaultGrade, gradeFn, writeCube } from '@shared/grade';
import { buildMatchEdit, fitLook, motionWindows, v1Clips, type RefAnalysis } from '@shared/matchedit';
import { placement } from '@shared/timeline';
import { probe, FFMPEG } from '../../electron/media';
import { analyzeReference, sampleColors } from '../../electron/reference';

const MEDIA = path.resolve(__dirname, '..', 'media');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'psp-match-'));
const media: Record<string, MediaItem> = {};
let ref: RefAnalysis;

beforeAll(async () => {
  if (!fs.existsSync(path.join(MEDIA, 'reference-edit.mp4'))) execFileSync(process.execPath, [path.resolve(__dirname, '..', '..', 'scripts', 'gen-media.mjs')]);
  for (const f of ['reference-edit.mp4', 'city-1080p30.mp4', 'bars-720p25.mp4', 'vertical-720x1280.mp4'])
    media[f] = { ...(await probe(path.join(MEDIA, f))), id: uid('m'), importedAt: new Date().toISOString() };
  ref = await analyzeReference(media['reference-edit.mp4'].path);
}, 120_000);

const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
const frame = 1 / 30;

describe('reference analysis', () => {
  it('finds every shot boundary within a frame', () => {
    expect(ref.shots.map(s => s.start)).toHaveLength(5);
    [0, 2, 4, 5.4, 8.4].forEach((t, i) => expect(near(ref.shots[i].start, t, frame * 1.01), `shot ${i + 1} starts at ${ref.shots[i].start}`).toBe(true));
    expect(near(ref.duration, 11.4, 0.05)).toBe(true);
  });

  it('classifies cuts, the dissolve, the dip and the fades', () => {
    expect(ref.shots[1].transitionIn).toBeNull();
    expect(ref.shots[2].transitionIn).toBeNull();
    expect(ref.shots[3].transitionIn?.type).toBe('dissolve');
    expect(near(ref.shots[3].transitionIn!.duration, 0.6, 0.1)).toBe(true);
    expect(ref.shots[4].transitionIn?.type).toBe('dip');
    expect(ref.shots[4].transitionIn!.duration).toBeGreaterThan(0.6);
    expect(ref.shots[4].transitionIn!.duration).toBeLessThan(1.1);
    expect(near(ref.shots[0].fadeIn, 0.5, 0.1)).toBe(true);
    expect(near(ref.shots[4].fadeOut, 0.5, 0.1)).toBe(true);
  });

  it('measures the zoom and the pan', () => {
    const zoom = ref.shots[1].motion!, pan = ref.shots[3].motion!;
    expect(zoom).toBeTruthy();
    expect(near(zoom.size, 1 / 1.3, 0.04)).toBe(true);
    // anchored at the top-left corner: the window's corner stays at 0,0
    expect(near(zoom.cx - zoom.size / 2, 0, 0.02) && near(zoom.cy - zoom.size / 2, 0, 0.02)).toBe(true);
    expect(pan).toBeTruthy();
    expect(near(pan.cx, 0.75, 0.04) && near(pan.cy, 0.5, 0.02) && near(pan.size, 1, 0.04)).toBe(true);
    expect(ref.shots[4].motion).toBeNull();
  });

  it('turns a move into crop windows that stay inside the picture', () => {
    for (const m of [{ cx: 0.5, cy: 0.5, size: 0.77 }, { cx: 0.75, cy: 0.5, size: 1 }, { cx: 0.3, cy: 0.6, size: 1.2 }]) {
      const { from, to } = motionWindows(m);
      for (const r of [from, to]) {
        expect(r.x).toBeGreaterThanOrEqual(-1e-9); expect(r.y).toBeGreaterThanOrEqual(-1e-9);
        expect(r.x + r.w).toBeLessThanOrEqual(1 + 1e-9); expect(r.y + r.h).toBeLessThanOrEqual(1 + 1e-9);
      }
      expect(near(to.w / from.w, m.size, 1e-9)).toBe(true);
      expect(near((to.x + to.w / 2 - from.x) / from.w, m.cx, 1e-9)).toBe(true);
    }
  });
});

describe('look matching', () => {
  it('fits a grade that moves footage toward the reference look', () => {
    const footage: number[] = [];
    for (let i = 0; i < 300; i++) { const v = (i % 100) / 100; footage.push(v * 0.8, v * 0.8, v * 0.8 + 0.05); }
    // reference: the same picture, warmer and brighter
    const target: number[] = [];
    for (let i = 0; i < footage.length; i += 3) target.push(Math.min(1, footage[i] * 1.25 + 0.06), Math.min(1, footage[i + 1] * 1.15 + 0.03), Math.min(1, footage[i + 2] * 0.95));
    const g = fitLook(target, footage);
    const f = gradeFn(g);
    const err = (px: number[]) => { let s = 0; for (let i = 0; i < px.length; i += 3) for (let k = 0; k < 3; k++) s += Math.abs(px[i + k] - target[i + k]); return s / px.length; };
    const graded: number[] = [];
    for (let i = 0; i < footage.length; i += 3) graded.push(...f(footage[i], footage[i + 1], footage[i + 2]));
    expect(err(graded)).toBeLessThan(err(footage) * 0.5);
    expect(g.temperature).toBeGreaterThan(0);
  });
});

describe('building and rendering a matched edit', () => {
  let p: Project;
  it('rebuilds the reference structure from new footage', () => {
    p = newProject('Match');
    p.settings = { ...p.settings, width: 1280, height: 720, fps: 30 };
    p.media.push(media['reference-edit.mp4'], media['city-1080p30.mp4'], media['vertical-720x1280.mp4'], media['bars-720p25.mp4']);
    const footage = [media['city-1080p30.mp4'], media['vertical-720x1280.mp4'], media['bars-720p25.mp4']];
    const n = buildMatchEdit(p, media['reference-edit.mp4'], ref, footage, { motion: true, color: false, fill: true, audio: 'reference' }, null);
    expect(n).toBe(5);
    const v = v1Clips(p);
    expect(v.map(c => c.start)).toEqual(ref.shots.map(s => Math.round(s.start * 30)));
    expect(v[v.length - 1].start + v[v.length - 1].duration).toBe(342);
    expect(v.map(c => c.mediaId)).toEqual([0, 1, 2, 0, 1].map(i => footage[i].id));
    expect(v[3].transitionIn?.type).toBe('dissolve');
    expect(v[4].transitionIn?.type).toBe('dip');
    expect(v[0].fadeIn).toBeGreaterThan(10);
    expect(v[1].motion && v[3].motion).toBeTruthy();
    expect(v[1].transform.scale).toBeGreaterThan(3); // portrait clip fills a landscape frame
    // Segments sit inside their media, including the dissolve tail
    for (const c of v) { const m = p.media.find(x => x.id === c.mediaId)!; expect(c.srcIn + c.duration / 30).toBeLessThanOrEqual(m.duration + 0.7); }
    const audio = p.clips.filter(c => p.tracks.find(t => t.id === c.trackId)?.kind === 'audio');
    expect(audio).toHaveLength(1);
    expect(audio[0].mediaId).toBe(media['reference-edit.mp4'].id);
    // The move changes the crop over the clip, not the picture size
    const c = v[1], m = p.media.find(x => x.id === c.mediaId)!;
    const a = placement(p, c, m.width, m.height, c.start), b = placement(p, c, m.width, m.height, c.start + c.duration - 1);
    expect(a.w).toBe(b.w);
    expect(b.crop[2] + b.crop[0]).toBeGreaterThan(a.crop[2] + a.crop[0]);
  });

  it('exports a video with the same cuts and moves as the reference', async () => {
    const out = path.join(OUT, 'matched.mp4');
    const cmd = buildExport(p, { format: 'h264', output: out, crf: 16 }, { luts: {}, titles: {} });
    try { execFileSync(FFMPEG, cmd.args, { stdio: ['ignore', 'ignore', 'pipe'] }); }
    catch (e: any) { throw new Error(`${e.stderr}\n--- graph ---\n${cmd.graph}`); }
    const again = await analyzeReference(out);
    expect(again.shots.map(s => Math.round(s.start * 30))).toEqual(ref.shots.map(s => Math.round(s.start * 30)));
    expect(again.shots[3].transitionIn?.type).toBe('dissolve');
    expect(again.shots[4].transitionIn?.type).toBe('dip');
    const pan = again.shots[3].motion;
    expect(pan && near(pan.cx, 0.75, 0.05)).toBe(true);
  }, 180_000);

  it('samples footage colors and grades toward the reference', async () => {
    const px = await sampleColors(media['city-1080p30.mp4'].path, [1, 5], false);
    expect(px.length).toBe(2 * 16 * 9 * 3);
    const g = fitLook(ref.colors, px);
    const lut = bakeLut(g);
    expect(writeCube(lut).length).toBeGreaterThan(1000);
    expect(g).not.toEqual(defaultGrade());
  });
});
