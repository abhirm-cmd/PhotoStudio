/**
 * On-device image analysis and tagging.
 *
 * The built-in analyzer is a colour/structure heuristic engine (no network, no
 * model download): it reads the photo's preview and derives scene tags such as
 * sky, vegetation, water, sunset, night, portrait or monochrome from colour
 * statistics, spatial layout and EXIF. It is labelled as heuristic in the UI.
 * A model-based provider (e.g. an ONNX classifier) can be registered through
 * `registerTagger` and is preferred when present.
 */
import { api, media } from '../api';
import { useLibrary } from '../store/library';
import { useApp } from '../store/app';
import { srgbToLinear, linearSrgbToOklab } from '@shared/color';
import type { Photo } from '@shared/types';

export interface Tagger { id: string; label: string; kind: 'model' | 'heuristic'; tag(photo: Photo, img: ImageData): Promise<string[]> }

const taggers: Tagger[] = [];
export function registerTagger(t: Tagger) { taggers.unshift(t); }
export function activeTagger(): Tagger { return taggers[0] ?? heuristicTagger; }

export async function loadImageData(url: string, edge = 256): Promise<ImageData> {
  const blob = await (await fetch(url)).blob();
  const bmp = await createImageBitmap(blob);
  const k = Math.min(1, edge / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  return ctx.getImageData(0, 0, w, h);
}

export interface ColorStats {
  meanL: number; meanC: number; sky: number; skyTop: number; foliage: number; water: number; skin: number; warm: number; snow: number;
  dark: number; bright: number; mono: boolean; palette: [number, number, number][]; edges: number;
}

export function colorStats(img: ImageData): ColorStats {
  const { width: w, height: h, data } = img;
  let L = 0, C = 0, sky = 0, skyTop = 0, foliage = 0, water = 0, skin = 0, warm = 0, snow = 0, dark = 0, bright = 0, n = 0, edges = 0;
  const lum = new Float32Array(w * h);
  const bins = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
    const [l, a, bb] = linearSrgbToOklab([srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)]);
    const c = Math.hypot(a, bb), hue = ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360;
    lum[y * w + x] = l;
    L += l; C += c; n++;
    const top = y < h * 0.5;
    if (hue > 200 && hue < 275 && l > 0.5 && c > 0.03) { sky++; if (top) skyTop++; }
    if (!top && hue > 190 && hue < 260 && c > 0.03 && l > 0.3 && l < 0.75) water++;
    if (hue > 105 && hue < 170 && c > 0.04 && l > 0.2) foliage++;
    if (hue > 20 && hue < 90 && c > 0.03 && c < 0.15 && l > 0.35 && l < 0.9) skin++;
    if ((hue < 80 || hue > 340) && c > 0.08) warm++;
    if (l > 0.88 && c < 0.03) snow++;
    if (l < 0.25) dark++;
    if (l > 0.8) bright++;
    const key = ((data[i] >> 5) << 6) | ((data[i + 1] >> 5) << 3) | (data[i + 2] >> 5);
    const bin = bins.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    bin.n++; bin.r += r; bin.g += g; bin.b += b;
    bins.set(key, bin);
  }
  for (let y = 1; y < h; y++) for (let x = 1; x < w; x++) {
    const v = lum[y * w + x];
    edges += Math.abs(v - lum[y * w + x - 1]) + Math.abs(v - lum[(y - 1) * w + x]);
  }
  const N = Math.max(1, n);
  const palette = [...bins.values()].sort((p, q) => q.n - p.n).slice(0, 6).map(b => [b.r / b.n, b.g / b.n, b.b / b.n] as [number, number, number]);
  return {
    meanL: L / N, meanC: C / N, sky: sky / N, skyTop: skyTop / N, foliage: foliage / N, water: water / N, skin: skin / N, warm: warm / N,
    snow: snow / N, dark: dark / N, bright: bright / N, mono: C / N < 0.012, palette, edges: edges / N,
  };
}

export const heuristicTagger: Tagger = {
  id: 'lumora-heuristic', label: 'Lumora scene analysis (heuristic, on-device)', kind: 'heuristic',
  async tag(photo, img) {
    const s = colorStats(img);
    const t = new Set<string>();
    const portraitFrame = img.height > img.width * 1.1;
    if (s.mono) t.add('monochrome');
    else if (s.meanC > 0.09) t.add('colorful');
    if (s.skyTop > 0.12) t.add('sky');
    if (s.foliage > 0.15) { t.add('vegetation'); if (s.foliage > 0.35) t.add('forest'); }
    if (s.water > 0.1 && s.skyTop > 0.05) t.add('water');
    if (s.snow > 0.25) t.add('snow');
    if (s.meanL < 0.3 && s.dark > 0.55) { t.add('low light'); if (s.skyTop < 0.05) t.add('night'); }
    if (s.bright > 0.4) t.add('bright');
    if (s.warm > 0.25 && s.meanL < 0.6 && s.skyTop + s.warm > 0.3) t.add(s.meanL < 0.42 ? 'sunset' : 'golden hour');
    if (s.skin > 0.12 && s.skin < 0.7) { t.add('people'); if (portraitFrame || s.skin > 0.22) t.add('portrait'); }
    const f = photo.exif.focalLength ?? 0;
    if ((s.skyTop > 0.1 || s.foliage > 0.2) && !portraitFrame && s.skin < 0.15) t.add('landscape');
    if (s.skyTop > 0.08 || s.foliage > 0.2 || s.water > 0.1 || s.snow > 0.25) t.add('outdoor');
    else if (s.meanL < 0.55 && s.warm > 0.12 && s.skyTop < 0.02) t.add('indoor');
    if (f >= 90 && s.edges > 0.12 && s.skin < 0.1 && !t.has('landscape')) t.add('macro');
    if (s.edges > 0.16 && s.skyTop > 0.05 && s.foliage < 0.1) t.add('architecture');
    return [...t];
  },
};

export async function analyzeAndTag(photos: Photo[]) {
  const app = useApp.getState();
  if (app.settings?.ai.provider === 'off') {
    app.toast({ kind: 'info', title: 'AI analysis is turned off', body: 'Turn it on in Settings › AI. Analysis runs on this computer.' });
    return;
  }
  const tagger = activeTagger();
  const task = `tag-${Date.now()}`;
  let done = 0;
  for (const p of photos) {
    app.setTask({ id: task, label: 'Analyzing photos', done, total: photos.length, detail: p.filename });
    try {
      const img = await loadImageData(media.thumb(p.id, Date.now()));
      const tags = await tagger.tag(p, img);
      await api.setAiTags(p.id, tags);
      useLibrary.getState().patchPhotos([p.id], { aiTags: tags });
    } catch (e) { console.warn('tagging failed', p.filename, e); }
    done++;
  }
  app.endTask(task);
  useLibrary.getState().refreshMeta();
  app.toast({ kind: 'success', title: `Analyzed ${done} photo${done > 1 ? 's' : ''}`, body: `${tagger.label}. Nothing left this computer. Search by tags like “sky” or “portrait”.` });
}
