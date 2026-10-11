/** Match Edit: decode a reference video into small analysis frames and footage color samples with FFmpeg. */
import { spawn } from 'node:child_process';
import { FFMPEG, probe } from './media';
import { ANALYSIS_COLOR, analysisSize, analyzeFrames, type AFrame, type RefAnalysis } from '../src/shared/matchedit';

/** Average an RGB frame down to the small color thumbnail. */
function colorThumb(rgb: Buffer, w: number, h: number): Uint8Array {
  const { w: W, h: H } = ANALYSIS_COLOR;
  const out = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const x0 = Math.floor((x * w) / W), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * w) / W));
    const y0 = Math.floor((y * h) / H), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * h) / H));
    let r = 0, g = 0, b = 0, n = 0;
    for (let j = y0; j < y1; j++) for (let i = x0; i < x1; i++) { const k = (j * w + i) * 3; r += rgb[k]; g += rgb[k + 1]; b += rgb[k + 2]; n++; }
    const o = (y * W + x) * 3; out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n;
  }
  return out;
}

export async function analyzeReference(file: string, onProgress?: (f: number) => void, signal?: { cancelled: boolean }): Promise<RefAnalysis> {
  const info = await probe(file);
  if (!info.hasVideo) throw new Error('The reference needs a video track.');
  const fps = Math.min(60, info.fps || 30);
  const frames = Math.max(1, Math.ceil(info.duration * fps));
  // keep all frames in memory: about 80 MB at most
  const area = Math.max(2304, Math.min(9216, Math.floor(80e6 / frames)));
  const size = analysisSize(info.width, info.height, area);
  const frameBytes = size.w * size.h * 3;
  const out: AFrame[] = [];
  await new Promise<void>((resolve, reject) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-nostdin', '-v', 'error', '-i', file, '-an', '-vf', `fps=${fps},scale=${size.w}:${size.h}:flags=area,format=rgb24`, '-f', 'rawvideo', 'pipe:1'], { windowsHide: true });
    let buf: Buffer = Buffer.alloc(0), err = '';
    p.stdout.on('data', (d: Buffer) => {
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      while (buf.length >= frameBytes) {
        const f = buf.subarray(0, frameBytes);
        const gray = new Uint8Array(size.w * size.h);
        for (let i = 0; i < gray.length; i++) gray[i] = (f[i * 3] * 54 + f[i * 3 + 1] * 183 + f[i * 3 + 2] * 19) >> 8;
        out.push({ gray, rgb: colorThumb(f, size.w, size.h) });
        buf = Buffer.from(buf.subarray(frameBytes));
        if (out.length % 15 === 0) onProgress?.(Math.min(0.95, out.length / frames));
        if (signal?.cancelled) p.kill('SIGKILL');
      }
    });
    p.stderr.on('data', d => { err += d; });
    p.on('error', reject);
    p.on('close', code => (signal?.cancelled ? reject(new Error('Cancelled')) : code === 0 ? resolve() : reject(new Error(err.trim().split('\n').pop() || `FFmpeg exited with ${code}`))));
  });
  if (out.length < 2) throw new Error('The reference is too short to analyse.');
  const a = analyzeFrames(out, size, fps, { width: info.width, height: info.height, hasAudio: info.hasAudio });
  onProgress?.(1);
  return a;
}

/** Small RGB samples (0..1 triplets) of a media file at the given source times. */
export async function sampleColors(file: string, times: number[], still = false): Promise<number[]> {
  const { w, h } = ANALYSIS_COLOR;
  const out: number[] = [];
  for (const t of still ? [0] : times) {
    const args = ['-hide_banner', '-nostdin', '-v', 'error', ...(still ? [] : ['-ss', t.toFixed(3)]), '-i', file, '-frames:v', '1', '-an', '-vf', `scale=${w}:${h}:flags=area,format=rgb24`, '-f', 'rawvideo', 'pipe:1'];
    const buf = await new Promise<Buffer>((resolve, reject) => {
      const p = spawn(FFMPEG, args, { windowsHide: true });
      const chunks: Buffer[] = [];
      p.stdout.on('data', d => chunks.push(d));
      p.on('error', reject);
      p.on('close', () => resolve(Buffer.concat(chunks)));
    });
    for (let i = 0; i + 2 < Math.min(buf.length, w * h * 3); i += 3) out.push(buf[i] / 255, buf[i + 1] / 255, buf[i + 2] / 255);
  }
  return out;
}
