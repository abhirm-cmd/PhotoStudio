/**
 * Builds the FFmpeg command that renders a timeline. It uses the same segment
 * resolution, placement math and baked grading LUTs as the preview player.
 */
import { type Project, mediaOf, dbToGain } from './project';
import { videoSegments, audioSegments, placement, type VideoSegment } from './timeline';

export type ExportFormat = 'h264' | 'h265' | 'prores' | 'wav' | 'mp3' | 'aac';

export interface ExportOptions {
  format: ExportFormat;
  /** Output frame size (defaults to the project size) */
  width?: number;
  height?: number;
  /** H.264/H.265 constant quality (lower = better) */
  crf?: number;
  audioBitrate?: number; // kbps
  /** Timeline range in frames, [from, to) */
  from?: number;
  to?: number;
  output: string;
}

export interface ExportAssets {
  /** Baked grade LUT file per clip id (.cube); clips without an entry are ungraded */
  luts: Record<string, string>;
  /** Rendered PNG per title clip id */
  titles: Record<string, string>;
}

export const FORMAT_INFO: Record<ExportFormat, { label: string; ext: string; video: boolean }> = {
  h264: { label: 'H.264 (MP4)', ext: 'mp4', video: true },
  h265: { label: 'H.265 / HEVC (MP4)', ext: 'mp4', video: true },
  prores: { label: 'Apple ProRes 422 HQ (MOV)', ext: 'mov', video: true },
  wav: { label: 'WAV audio (48 kHz, 24-bit)', ext: 'wav', video: false },
  mp3: { label: 'MP3 audio (320 kbps)', ext: 'mp3', video: false },
  aac: { label: 'AAC audio (M4A)', ext: 'm4a', video: false },
};

/** Frame rate as FFmpeg expects it (NTSC rates as exact fractions). */
export const fpsArg = (fps: number) => {
  for (const base of [24, 30, 60, 120]) if (Math.abs(fps - (base * 1000) / 1001) < 0.01) return `${base * 1000}/1001`;
  return String(fps);
};

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
const num = (n: number, d = 6) => Number(n.toFixed(d)).toString();
/** Escape a path for use inside a filtergraph option value. */
export const escPath = (p: string) => p.replace(/\\/g, '/').replace(/'/g, "'\\''").replace(/:/g, '\\:');

/** atempo only accepts 0.5–2 per instance; chain for other speeds. */
export function atempoChain(speed: number): string[] {
  const out: string[] = [];
  let s = speed;
  while (s > 2) { out.push('atempo=2'); s /= 2; }
  while (s < 0.5) { out.push('atempo=0.5'); s /= 0.5; }
  if (Math.abs(s - 1) > 1e-6) out.push(`atempo=${num(s)}`);
  return out;
}

export interface BuiltCommand { args: string[]; graph: string; duration: number }

export function buildExport(p: Project, o: ExportOptions, assets: ExportAssets): BuiltCommand {
  const fps = p.settings.fps;
  const { width: W, height: H } = p.settings;
  const from = Math.max(0, o.from ?? 0);
  const total = p.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0);
  const to = Math.max(from + 1, Math.min(o.to ?? total, total || from + 1));
  const T = (to - from) / fps;
  const info = FORMAT_INFO[o.format];
  const outW = even(o.width ?? W), outH = even(o.height ?? H);

  const inputs: string[][] = [];
  const graph: string[] = [];
  const addInput = (a: string[]) => { inputs.push(a); return inputs.length - 1; };

  /* ------------------------------------------------------------ video */
  let vLabel: string | null = null;
  if (info.video) {
    const base = addInput(['-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=${fpsArg(fps)}:d=${num(T)}`]);
    graph.push(`[${base}:v]format=rgba,setsar=1[vb0]`);
    vLabel = 'vb0';
    const segs = videoSegments(p)
      .filter(s => s.to > from && s.from < to)
      .sort((a, b) => a.layer - b.layer || a.clip.start - b.clip.start);
    segs.forEach((s, i) => {
      const lab = videoChain(p, s, i, from, to, assets, addInput);
      if (!lab) return;
      graph.push(lab.chain);
      const next = `vb${i + 1}`;
      graph.push(`[${vLabel}][${lab.label}]overlay=x=${lab.x}:y=${lab.y}:eof_action=pass:format=auto:eval=${lab.slide ? 'frame' : 'init'}[${next}]`);
      vLabel = next;
    });
    const pix = o.format === 'prores' ? 'yuv422p10le' : 'yuv420p';
    graph.push(`[${vLabel}]scale=${outW}:${outH}:flags=lanczos:out_color_matrix=bt709:out_range=tv,format=${pix},trim=duration=${num(T)}[vout]`);
  }

  /* ------------------------------------------------------------ audio */
  const aSegs = audioSegments(p).filter(s => s.to > from && s.from < to);
  const aLabels: string[] = [];
  aSegs.forEach((s, i) => {
    const m = mediaOf(p, s.clip.mediaId)!;
    const c = s.clip;
    const f0 = Math.max(s.from, from), f1 = Math.min(s.to, to);
    const srcStart = s.srcAt + ((f0 - s.from) / fps) * c.speed;
    const srcDur = ((f1 - f0) / fps) * c.speed;
    const k = addInput(['-ss', num(srcStart), '-t', num(srcDur + 0.05), '-i', m.path]);
    const segDur = (f1 - f0) / fps;
    const A = (f0 - c.start) / fps, B = (c.start + c.duration - f0) / fps;
    const fi = c.fadeIn / fps, fo = c.fadeOut / fps;
    const g = dbToGain(s.gainDb);
    let vol = `${num(g)}`;
    if (fi > 0) vol += `*min(1\\,(t+${num(A)})/${num(fi)})`;
    if (fo > 0) vol += `*min(1\\,max(0\\,(${num(B)}-t)/${num(fo)}))`;
    // Mono goes to both sides at full level (as Web Audio plays it), not FFmpeg's -3 dB upmix
    const parts = [`[${k}:a]aresample=${p.settings.sampleRate}`, ...(m.channels === 1 ? ['pan=stereo|c0=c0|c1=c0'] : []), 'aformat=channel_layouts=stereo:sample_fmts=fltp', 'asetpts=PTS-STARTPTS', ...atempoChain(c.speed), `volume='${vol}':eval=frame`];
    if (s.pan) {
      const L = Math.min(1, 1 - s.pan), R = Math.min(1, 1 + s.pan);
      parts.push(`pan=stereo|c0=${num(L)}*c0|c1=${num(R)}*c1`);
    }
    parts.push(`atrim=duration=${num(segDur)}`);
    const delay = Math.round(((f0 - from) / fps) * 1000);
    if (delay > 0) parts.push(`adelay=${delay}:all=1`);
    graph.push(`${parts.join(',')}[a${i}]`);
    aLabels.push(`[a${i}]`);
  });
  const silence = addInput(['-f', 'lavfi', '-i', `anullsrc=r=${p.settings.sampleRate}:cl=stereo`]);
  graph.push(`[${silence}:a]atrim=duration=${num(T)}[asil]`);
  graph.push(`[asil]${aLabels.join('')}amix=inputs=${aLabels.length + 1}:normalize=0:dropout_transition=0,atrim=duration=${num(T)}[aout]`);

  /* ---------------------------------------------------------- output */
  const args: string[] = ['-hide_banner', '-y', '-nostdin'];
  for (const a of inputs) args.push(...a);
  args.push('-filter_complex', graph.join(';\n'));
  if (info.video) args.push('-map', '[vout]');
  args.push('-map', '[aout]');
  if (info.video) args.push('-r', fpsArg(fps));
  const ab = `${o.audioBitrate ?? 320}k`;
  switch (o.format) {
    case 'h264': args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', String(o.crf ?? 18), '-profile:v', 'high', '-c:a', 'aac', '-b:a', ab, '-movflags', '+faststart'); break;
    case 'h265': args.push('-c:v', 'libx265', '-preset', 'medium', '-crf', String(o.crf ?? 22), '-tag:v', 'hvc1', '-c:a', 'aac', '-b:a', ab, '-movflags', '+faststart'); break;
    case 'prores': args.push('-c:v', 'prores_ks', '-profile:v', '3', '-vendor', 'apl0', '-c:a', 'pcm_s24le'); break;
    case 'wav': args.push('-c:a', 'pcm_s24le'); break;
    case 'mp3': args.push('-c:a', 'libmp3lame', '-b:a', ab); break;
    case 'aac': args.push('-c:a', 'aac', '-b:a', ab); break;
  }
  if (info.video) args.push('-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv');
  args.push('-ar', String(p.settings.sampleRate), '-t', num(T), '-progress', 'pipe:1', '-nostats', o.output);
  return { args, graph: graph.join(';\n'), duration: T };
}

function videoChain(p: Project, s: VideoSegment, i: number, from: number, to: number, assets: ExportAssets, addInput: (a: string[]) => number) {
  const fps = p.settings.fps;
  const c = s.clip;
  const f0 = Math.max(s.from, from), f1 = Math.min(s.to, to);
  if (f1 <= f0) return null;
  const segDur = (f1 - f0) / fps;
  const offset = (f0 - from) / fps;
  const local = (f0 - s.from) / fps; // seconds into the segment where this render starts
  let k: number, srcW: number, srcH: number;
  const pre: string[] = [];

  if (c.kind === 'title') {
    const png = assets.titles[c.id];
    if (!png) return null;
    k = addInput(['-loop', '1', '-framerate', fpsArg(fps), '-t', num(segDur), '-i', png]);
    srcW = p.settings.width; srcH = p.settings.height;
  } else if (c.kind === 'color') {
    k = addInput(['-f', 'lavfi', '-i', `color=c=${(c.color ?? '#000000').replace('#', '0x')}:s=${p.settings.width}x${p.settings.height}:r=${fpsArg(fps)}:d=${num(segDur)}`]);
    srcW = p.settings.width; srcH = p.settings.height;
  } else {
    const m = mediaOf(p, c.mediaId);
    if (!m) return null;
    srcW = m.width; srcH = m.height;
    if (m.kind === 'image') {
      k = addInput(['-loop', '1', '-framerate', fpsArg(fps), '-t', num(segDur), '-i', m.path]);
    } else {
      const srcStart = s.srcAt + local * c.speed;
      const need = segDur * c.speed;
      k = addInput(['-ss', num(srcStart), '-t', num(need + 0.1), '-i', m.path]);
      pre.push('setpts=PTS-STARTPTS');
      if (c.speed !== 1) pre.push(`setpts=PTS/${num(c.speed)}`);
      // Media shorter than the segment (a transition tail past the end): hold the last frame
      const avail = (m.duration - srcStart) / c.speed;
      if (avail < segDur) pre.push(`tpad=stop_mode=clone:stop_duration=${num(segDur - Math.max(0, avail) + 0.1)}`);
      const matrix = m.colorSpace?.includes('601') || m.colorSpace?.includes('470') || m.colorSpace === 'smpte170m' ? 'bt601' : 'bt709';
      pre.push(`scale=in_color_matrix=${matrix}`);
    }
    pre.push(`fps=${fpsArg(fps)}`);
  }

  const pl = placement(p, c, srcW, srcH);
  const [cl, ct, cr, cb] = pl.crop;
  const parts = [`[${k}:v]${pre.length ? pre.join(',') + ',' : ''}setsar=1`];
  if (cl || ct || cr || cb) parts.push(`crop=w=iw*${num(1 - cl - cr)}:h=ih*${num(1 - ct - cb)}:x=iw*${num(cl)}:y=ih*${num(ct)}`);
  if (c.motion && c.kind === 'media') {
    // Animated zoom/pan: scale up so the moving window fills the picture size, then crop it out
    const PW = even(pl.w), PH = even(pl.h);
    const u = `clip((${num(f0 - c.start)}+t*${num(fps)})/${num(Math.max(1, c.duration - 1))}\\,0\\,1)`;
    const lerp = (a: number, b: number) => `(${num(a)}+${num(b - a)}*${u})`;
    const { from: A, to: B } = c.motion;
    parts.push(`scale=w='2*ceil(${PW}/${lerp(A.w, B.w)}/2)':h='2*ceil(${PH}/${lerp(A.h, B.h)}/2)':eval=frame:flags=bicubic`);
    // crop evaluates x/y per frame but keeps its initial input size, so position from t alone
    parts.push(`crop=w=${PW}:h=${PH}:x='${lerp(A.x, B.x)}*${PW}/${lerp(A.w, B.w)}':y='${lerp(A.y, B.y)}*${PH}/${lerp(A.h, B.h)}'`);
  } else {
    parts.push(`scale=${even(pl.w)}:${even(pl.h)}:flags=bicubic`);
  }
  const lut = assets.luts[c.id];
  if (lut) parts.push('format=rgb24', `lut3d=file='${escPath(lut)}':interp=tetrahedral`);
  parts.push('format=rgba');
  if (c.transform.flipH) parts.push('hflip');
  if (c.transform.flipV) parts.push('vflip');
  if (pl.rotation) parts.push(`rotate=a=${num((pl.rotation * Math.PI) / 180)}:ow=rotw(a):oh=roth(a):c=none`);
  if (c.opacity < 1) parts.push(`colorchannelmixer=aa=${num(c.opacity)}`);
  // Fades are expressed in this segment's local time (it starts at 0 after setpts)
  const rel = (f: number) => (f - f0) / fps;
  // A range that starts inside a fade begins the fade at 0 (FFmpeg's fade has no start value)
  const fade = (r: { start: number; dur: number }, kind: string) => {
    const st = rel(r.start), end = st + r.dur / fps;
    if (end <= 0) return null;
    return `fade=${kind}:st=${num(Math.max(0, st))}:d=${num(end - Math.max(0, st))}`;
  };
  const fades = [
    s.alphaIn && fade(s.alphaIn, 't=in') && `${fade(s.alphaIn, 't=in')}:alpha=1`,
    s.blackIn && fade(s.blackIn, 't=in') && `${fade(s.blackIn, 't=in')}:color=black`,
    s.blackOut && rel(s.blackOut.start) < segDur && `fade=t=out:st=${num(Math.max(0, rel(s.blackOut.start)))}:d=${num(s.blackOut.dur / fps)}:color=black`,
  ].filter(Boolean) as string[];
  parts.push(...fades);
  parts.push(`trim=duration=${num(segDur)}`, `setpts=PTS+${num(offset)}/TB`);
  const label = `v${i}`;
  const chain = parts.join(',') + `[${label}]`;
  const x0 = `${num(pl.cx)}-overlay_w/2`, y0 = `${num(pl.cy)}-overlay_h/2`;
  let x = x0;
  if (s.slideIn) {
    const st = (s.slideIn.start - from) / fps, d = s.slideIn.dur / fps;
    x = `'${num(pl.cx)}-overlay_w/2+main_w*max(0\\,1-(t-${num(st)})/${num(d)})'`;
  }
  return { chain, label, x, y: y0, slide: !!s.slideIn };
}
