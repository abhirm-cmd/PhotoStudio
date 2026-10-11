import { describe, it, expect } from 'vitest';
import { newProject, uid, clipEnd, type Project, type MediaItem } from '@shared/project';
import { clipsForMedia, placeClips, splitClip, splitAt, deleteClips, trimClip, moveClips, closeGap, videoSegments, layersAt, audioSegments, placement } from '@shared/timeline';
import { bakeLut, defaultGrade, gradeFn, parseCube, writeCube, isNeutral } from '@shared/grade';

const vid = (dur = 10): MediaItem => ({ id: uid('m'), path: '/x.mp4', name: 'x.mp4', kind: 'video', duration: dur, width: 1920, height: 1080, fps: 30, hasVideo: true, hasAudio: true, rotation: 0, size: 1, importedAt: '' });
function setup() {
  const p = newProject();
  const m = vid();
  p.media.push(m);
  const V1 = p.tracks[0].id, A1 = p.tracks.find(t => t.kind === 'audio')!.id;
  return { p, m, V1, A1 };
}
const on = (p: Project, t: string) => p.clips.filter(c => c.trackId === t).sort((a, b) => a.start - b.start);

describe('timeline editing', () => {
  it('creates linked video and audio clips from media', () => {
    const { p, m, V1, A1 } = setup();
    const cs = clipsForMedia(p, m.id, 0, { srcIn: 2, srcOut: 6 });
    expect(cs.map(c => c.trackId)).toEqual([V1, A1]);
    expect(cs.every(c => c.duration === 120 && c.srcIn === 2)).toBe(true);
    expect(cs[0].linkId).toBe(cs[1].linkId);
  });

  it('overwrite trims and splits what is underneath; insert pushes it right', () => {
    const { p, m, V1 } = setup();
    placeClips(p, clipsForMedia(p, m.id, 0, { srcOut: 10 }));            // 0..300
    placeClips(p, clipsForMedia(p, m.id, 100, { srcOut: 2 }));           // overwrite 100..160
    expect(on(p, V1).map(c => [c.start, c.duration])).toEqual([[0, 100], [100, 60], [160, 140]]);
    expect(on(p, V1)[2].srcIn).toBeCloseTo(160 / 30, 6);
    placeClips(p, clipsForMedia(p, m.id, 50, { srcOut: 1 }), 'insert');  // insert 30 frames at 50
    expect(on(p, V1).map(c => [c.start, c.duration])).toEqual([[0, 50], [50, 30], [80, 50], [130, 60], [190, 140]]);
  });

  it('splits linked clips together and razors every unlocked track', () => {
    const { p, m, V1, A1 } = setup();
    const [v] = clipsForMedia(p, m.id, 0, { srcOut: 4 });
    placeClips(p, clipsForMedia(p, m.id, 0, { srcOut: 4 }).map((c, i) => (i === 0 ? { ...c, id: v.id } : c)));
    splitClip(p, v.id, 30);
    expect(on(p, V1).length).toBe(2);
    expect(on(p, A1).length).toBe(2);
    expect(on(p, V1)[1].linkId).toBe(on(p, A1)[1].linkId);
    p.tracks.find(t => t.id === A1)!.locked = true;
    expect(splitAt(p, 60)).toBe(1);
  });

  it('ripple delete closes the gap; close gap pulls clips left', () => {
    const { p, m, V1 } = setup();
    for (const s of [0, 60, 120]) placeClips(p, clipsForMedia(p, m.id, s, { srcOut: 2 }));
    deleteClips(p, [on(p, V1)[1].id], true);
    expect(on(p, V1).map(c => c.start)).toEqual([0, 60]);
    moveClips(p, [on(p, V1)[1].id], 30);
    expect(on(p, V1).map(c => c.start)).toEqual([0, 90]);
    expect(closeGap(p, V1, 70)).toBe(30);
    expect(on(p, V1).map(c => c.start)).toEqual([0, 60]);
  });

  it('trims respect media length and ripple shifts later clips', () => {
    const { p, m, V1 } = setup();
    placeClips(p, clipsForMedia(p, m.id, 0, { srcIn: 8, srcOut: 9 }));    // 30 frames, 2 s of media left after
    placeClips(p, clipsForMedia(p, m.id, 30, { srcOut: 1 }));
    trimClip(p, on(p, V1)[0].id, 'out', 500, true);
    expect(on(p, V1)[0].duration).toBe(60);                               // limited by the 10 s media
    expect(on(p, V1)[1].start).toBe(60);
    trimClip(p, on(p, V1)[0].id, 'in', 15);
    expect(on(p, V1)[0].srcIn).toBeCloseTo(8.5, 6);
  });

  it('moves a video clip up a track without moving its audio', () => {
    const { p, m, V1, A1 } = setup();
    placeClips(p, clipsForMedia(p, m.id, 0, { srcOut: 1 }));
    moveClips(p, [on(p, V1)[0].id], 10, { video: 1, audio: 0 });
    const V2 = p.tracks.filter(t => t.kind === 'video')[1].id;
    expect(on(p, V2)[0].start).toBe(10);
    expect(on(p, A1)[0].start).toBe(10);
  });
});

describe('render resolution', () => {
  it('a dissolve extends the outgoing clip and ramps the incoming alpha', () => {
    const { p, m } = setup();
    placeClips(p, clipsForMedia(p, m.id, 0, { srcOut: 2 }));
    const [b] = clipsForMedia(p, m.id, 60, { srcIn: 5, srcOut: 7 });
    b.transitionIn = { type: 'dissolve', duration: 20 };
    placeClips(p, [b]);
    const segs = videoSegments(p);
    expect(segs[0].to).toBe(80);
    const mid = layersAt(p, 70, segs);
    expect(mid.length).toBe(2);
    expect(mid[1].alpha).toBeCloseTo(0.5, 5);
    expect(mid[0].srcTime).toBeCloseTo(70 / 30, 5);
  });

  it('a dip goes to black at the cut', () => {
    const { p, m } = setup();
    placeClips(p, clipsForMedia(p, m.id, 0, { srcOut: 2 }));
    const [b] = clipsForMedia(p, m.id, 60, { srcOut: 2 });
    b.transitionIn = { type: 'dip', duration: 20 };
    placeClips(p, [b]);
    expect(layersAt(p, 59)[0].black).toBeCloseTo(0.9, 5);
    expect(layersAt(p, 60)[0].black).toBeCloseTo(1, 5);
    expect(layersAt(p, 70)[0].black).toBe(0);
  });

  it('muted and non-solo tracks drop out of the audio mix', () => {
    const { p, m, A1 } = setup();
    placeClips(p, clipsForMedia(p, m.id, 0, { srcOut: 1 }));
    expect(audioSegments(p).length).toBe(1);
    p.tracks.filter(t => t.kind === 'audio')[1].solo = true;
    expect(audioSegments(p).length).toBe(0);
    p.tracks.forEach(t => { t.solo = false; });
    p.tracks.find(t => t.id === A1)!.muted = true;
    expect(audioSegments(p).length).toBe(0);
  });

  it('fits portrait media inside the frame', () => {
    const { p, m } = setup();
    const [c] = clipsForMedia(p, m.id, 0, { srcOut: 1 });
    const pl = placement(p, c, 720, 1280);
    expect(pl.h).toBeCloseTo(1080, 5);
    expect(pl.w).toBeCloseTo(607.5, 5);
    expect([pl.cx, pl.cy]).toEqual([960, 540]);
  });
});

describe('grading', () => {
  it('a neutral grade bakes to an identity LUT', () => {
    const l = bakeLut(defaultGrade(), null, 9);
    for (let b = 0, i = 0; b < 9; b++) for (let g = 0; g < 9; g++) for (let r = 0; r < 9; r++, i += 3) {
      expect(l.data[i]).toBeCloseTo(r / 8, 4); expect(l.data[i + 1]).toBeCloseTo(g / 8, 4); expect(l.data[i + 2]).toBeCloseTo(b / 8, 4);
    }
    expect(isNeutral(defaultGrade())).toBe(true);
  });
  it('exposure, temperature and saturation move colors the expected way', () => {
    const f = gradeFn({ ...defaultGrade(), exposure: 1 });
    expect(f(0.5, 0.5, 0.5)[0]).toBeGreaterThan(0.6);
    const w = gradeFn({ ...defaultGrade(), temperature: 60 })(0.5, 0.5, 0.5);
    expect(w[0]).toBeGreaterThan(w[2]);
    const grey = gradeFn({ ...defaultGrade(), saturation: 0 })(0.8, 0.2, 0.1);
    expect(Math.max(...grey) - Math.min(...grey)).toBeLessThan(1e-6);
  });
  it('.cube files round-trip', () => {
    const l = bakeLut({ ...defaultGrade(), contrast: 30 }, null, 5);
    const back = parseCube(writeCube(l));
    expect(back.size).toBe(5);
    back.data.forEach((v, i) => expect(v).toBeCloseTo(l.data[i], 5));
  });
});
