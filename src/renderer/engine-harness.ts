// Development harness: exercises the render engine headlessly (used by tests/engine).
import { Renderer, type SourceImage } from './engine/pipeline';
import { decodeRaw } from './decode/libraw';
import { defaultEdit, type EditParams } from '@shared/edit';

const canvas = document.getElementById('c') as HTMLCanvasElement;
let renderer: Renderer | null = null;

(window as any).harness = {
  async loadRaw(url: string) {
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
    const t = performance.now();
    const r = await decodeRaw(bytes, true);
    const src: SourceImage = { id: url, kind: 'u16', width: r.width, height: r.height, data: r.data, primaries: 'prophoto', transfer: 'linear', isRaw: true, fullWidth: r.width * 2, fullHeight: r.height * 2, asShot: r.meta.asShot };
    renderer ??= new Renderer(canvas);
    renderer.setSource(src);
    return { w: r.width, h: r.height, ms: performance.now() - t, meta: r.meta };
  },
  async loadImage(url: string) {
    const bmp = await createImageBitmap(await (await fetch(url)).blob(), { imageOrientation: 'from-image', premultiplyAlpha: 'none' });
    const src: SourceImage = { id: url, kind: 'bitmap', width: bmp.width, height: bmp.height, bitmap: bmp, primaries: 'srgb', transfer: 'srgb', isRaw: false, fullWidth: bmp.width, fullHeight: bmp.height, asShot: { temp: 5500, tint: 0 } };
    renderer ??= new Renderer(canvas);
    renderer.setSource(src);
    return { w: bmp.width, h: bmp.height };
  },
  defaultEdit: (raw: boolean) => defaultEdit(raw),
  /** Render an edit and return a PNG data URL plus timing and mean color. */
  render(edit: EditParams, scale = 0.35) {
    const r = renderer!;
    const out = r.render(edit, { lens: null, assets: new Map() }, { scale });
    const px = r.readEncoded(out, 'srgb', 8) as Uint8Array;
    const cv = document.createElement('canvas');
    cv.width = out.width; cv.height = out.height;
    const ctx = cv.getContext('2d')!;
    const id = ctx.createImageData(out.width, out.height);
    let sr = 0, sg = 0, sb = 0;
    for (let i = 0, j = 0; i < px.length; i += 3, j += 4) { id.data[j] = px[i]; id.data[j + 1] = px[i + 1]; id.data[j + 2] = px[i + 2]; id.data[j + 3] = 255; sr += px[i]; sg += px[i + 1]; sb += px[i + 2]; }
    ctx.putImageData(id, 0, 0);
    const n = px.length / 3;
    return { url: cv.toDataURL('image/png'), w: out.width, h: out.height, ms: r.stats.lastRenderMs, mean: [sr / n, sg / n, sb / n] };
  },
};
(window as any).harnessReady = true;
