/**
 * EngineHost — the single long-lived GPU renderer behind the main viewer.
 * It owns a persistent canvas (moved between workspaces), loads sources for
 * the active photo, schedules renders on animation frames, and publishes the
 * histogram and view mapping for overlays.
 */
import { create } from 'zustand';
import { Renderer, type RenderContext, type RenderOutput, type MaskAsset } from './pipeline';
import { loadSource, DecodeError } from '../decode/sources';
import { useDevelop } from '../store/develop';
import { useApp } from '../store/app';
import type { Photo } from '@shared/types';
import { computeGeometry } from './geometry';
import { convertMatrix, SPACES } from '@shared/color';
import { lensCorrection, findProfile, matchProfile } from './lens';
import { loadMaskAssets } from '../services/offscreen';
import type { EditParams } from '@shared/edit';

export interface ViewMapping { ox: number; oy: number; dw: number; dh: number; zoom: number; fitZoom: number; outW: number; outH: number; cssW: number; cssH: number; side: boolean }
export interface Histo { r: Uint32Array; g: Uint32Array; b: Uint32Array; l: Uint32Array; clipHi: number; clipLo: number; total: number }

interface ViewStore { mapping: ViewMapping | null; histo: Histo | null; renderMs: number; ready: boolean; set(p: Partial<ViewStore>): void }
export const useView = create<ViewStore>(set => ({ mapping: null, histo: null, renderMs: 0, ready: false, set: p => set(p) }));

class EngineHost {
  canvas: HTMLCanvasElement;
  renderer: Renderer | null = null;
  error: string | null = null;
  photo: Photo | null = null;
  rawMeta: any = null;
  assets = new Map<string, MaskAsset>();
  out: RenderOutput | null = null;
  beforeOut: RenderOutput | null = null;
  private pending = false;
  private loadSeq = 0;
  private histoTimer = 0;
  private container: HTMLElement | null = null;
  private ro: ResizeObserver;
  private lastKey = '';

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'engine-canvas';
    this.canvas.setAttribute('aria-label', 'Photo preview');
    try { this.renderer = new Renderer(this.canvas); }
    catch (e: any) { this.error = String(e?.message ?? e); }
    this.ro = new ResizeObserver(() => this.requestRender());
    useDevelop.subscribe(() => this.requestRender());
  }

  attach(el: HTMLElement) {
    this.container = el;
    el.prepend(this.canvas);
    this.ro.disconnect();
    this.ro.observe(el);
    this.requestRender();
  }
  detach(el: HTMLElement) { if (this.container === el) { this.container = null; this.ro.disconnect(); } }

  async setPhoto(photo: Photo | null) {
    const seq = ++this.loadSeq;
    if (!photo) { this.photo = null; this.out = null; this.requestRender(); return; }
    if (this.photo?.id === photo.id && this.renderer?.source) return;
    const dev = useDevelop.getState();
    dev.set({ loadingSource: true, sourceError: null });
    useView.getState().set({ ready: false });
    try {
      const edge = useApp.getState().settings?.performance.previewLongEdge ?? 2560;
      const [src, assets] = await Promise.all([loadSource(photo, 'preview', edge), loadMaskAssets(dev.edit, photo.id)]);
      if (seq !== this.loadSeq) return;
      this.assets = assets;
      this.photo = photo;
      this.rawMeta = src.rawMeta ?? null;
      this.renderer?.setSource(src);
      this.out = null; this.beforeOut = null; this.lastKey = '';
      dev.setAsShot(src.asShot);
      dev.set({ loadingSource: false });
      useView.getState().set({ ready: true });
      this.requestRender();
    } catch (e: any) {
      if (seq !== this.loadSeq) return;
      this.photo = photo;
      const err = e instanceof DecodeError ? { message: e.message, detail: e.detail } : { message: 'Unable to open this photo.', detail: String(e?.message ?? e) };
      dev.set({ loadingSource: false, sourceError: err });
      this.renderer && (this.renderer.source = null);
      this.out = null;
      this.requestRender();
    }
  }

  /** Register a freshly generated mask bitmap (AI / portrait masks) for the open photo. */
  setAsset(a: MaskAsset) {
    this.assets.set(a.key, a);
    this.renderer?.invalidateAsset(a.key);
    this.lastKey = '';
    this.requestRender();
  }

  renderContext(e: EditParams): RenderContext {
    const p = this.photo;
    const src = this.renderer?.source;
    let lens = null;
    if (p && src) {
      const g = computeGeometry(e, src.width, src.height, null);
      const prof = e.optics.profileId ? findProfile(e.optics.profileId) : matchProfile(p.exif.lens, p.exif.make);
      lens = lensCorrection(e.optics, prof, p.exif.focalLength, p.exif.aperture, g.frameW, g.frameH);
    }
    return { lens, assets: this.assets };
  }

  requestRender() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => { this.pending = false; this.frame(); });
  }

  private frame() {
    const r = this.renderer, el = this.container;
    if (!r || !el) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = el.clientWidth, cssH = el.clientHeight;
    const cw = Math.max(1, Math.round(cssW * dpr)), ch = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== cw || this.canvas.height !== ch) { this.canvas.width = cw; this.canvas.height = ch; }
    const gl = r.gl;
    const bg: [number, number, number] = [0.043, 0.047, 0.055];
    if (!r.source) { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, cw, ch); gl.clearColor(bg[0], bg[1], bg[2], 1); gl.clear(gl.COLOR_BUFFER_BIT); useView.getState().set({ mapping: null }); return; }

    const dev = useDevelop.getState();
    const edit = dev.previewEdit ?? dev.edit;
    const ignoreCrop = dev.tool === 'crop';
    const src = r.source;
    const rc = this.renderContext(edit);
    const g = computeGeometry(edit, src.width, src.height, rc.lens, { ignoreCrop });
    const fullK = src.fullWidth / src.width; // full-res px per source px
    const outFullW = g.outW * fullK, outFullH = g.outH * fullK;
    const side = dev.compare === 'side';
    const availW = side ? cw / 2 : cw;
    const pad = 0.94;
    const fitZoom = Math.min((availW * pad) / outFullW, (ch * pad) / outFullH);
    const zoom = dev.zoom === 'fit' ? fitZoom : dev.zoom === 'fill' ? Math.max(availW / outFullW, ch / outFullH) : dev.zoom * dpr;
    const dw = outFullW * zoom, dh = outFullH * zoom;
    // Render scale: enough source pixels for the displayed size, never more than source resolution
    const scale = Math.min(1, Math.max(0.05, (dw / g.outW) * 1.0));
    const key = JSON.stringify([edit, ignoreCrop, scale.toFixed(3), src.id]);
    if (key !== this.lastKey || !this.out) {
      try {
        this.out = r.render(edit, rc, { scale, ignoreCrop });
        this.lastKey = key;
      } catch (e: any) {
        console.error(e);
        useDevelop.getState().set({ sourceError: { message: 'Rendering failed.', detail: String(e?.message ?? e) } });
        return;
      }
      this.scheduleHisto();
    }
    const showBefore = dev.compare !== 'off' || dev.holdBefore;
    if (showBefore) this.beforeOut = r.renderBefore(dev.edit, rc, { scale, ignoreCrop });

    const [cx, cy] = dev.zoom === 'fit' || dev.zoom === 'fill' ? [0.5, 0.5] : dev.center;
    const canvasCx = side ? availW / 2 : cw / 2;
    const ox = canvasCx - cx * dw, oy = ch / 2 - cy * dh;
    // canvas px → uv
    const viewInv = [1 / dw, 0, -ox / dw, 0, 1 / dh, -oy / dh, 0, 0, 1];
    const displaySpace = useApp.getState().settings?.color.displayProfile === 'display-p3' ? SPACES['display-p3'] : SPACES.srgb;
    if ('drawingBufferColorSpace' in gl) (gl as any).drawingBufferColorSpace = displaySpace.id === 'display-p3' ? 'display-p3' : 'srgb';
    const output = convertMatrix(SPACES.rec2020, displaySpace);
    const maskIdx = dev.selectedMask && dev.maskOverlay && (useApp.getState().workspace === 'masking' || dev.tool === 'brush') ? edit.masks.findIndex(m => m.id === dev.selectedMask) : -1;
    const mode = dev.holdBefore ? 1 : ({ off: 0, before: 1, 'split-v': 2, 'split-h': 3, side: 0 } as const)[dev.compare];
    if (side && this.beforeOut) {
      // Draw before on the left half, after on the right half using scissor
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(0, 0, Math.floor(cw / 2), ch);
      r.draw(this.beforeOut.tex, null, { viewInv, mode: 0, split: 0.5, clipping: false, output, bg });
      const viewInv2 = [1 / dw, 0, -(ox + availW) / dw, 0, 1 / dh, -oy / dh, 0, 0, 1];
      gl.scissor(Math.floor(cw / 2), 0, cw - Math.floor(cw / 2), ch);
      r.draw(this.out!.tex, null, { viewInv: viewInv2, mode: 0, split: 0.5, clipping: dev.clipping, overlayMask: maskIdx, output, bg });
      gl.disable(gl.SCISSOR_TEST);
    } else {
      r.draw(this.out!.tex, showBefore ? this.beforeOut!.tex : null, { viewInv, mode: mode as any, split: dev.split, clipping: dev.clipping, overlayMask: maskIdx, overlayOpacity: 0.45, output, bg });
    }
    const mapping: ViewMapping = { ox: ox / dpr, oy: oy / dpr, dw: dw / dpr, dh: dh / dpr, zoom: zoom / dpr, fitZoom: fitZoom / dpr, outW: outFullW, outH: outFullH, cssW, cssH, side };
    const prev = useView.getState().mapping;
    if (!prev || Object.keys(mapping).some(k => Math.abs((prev as any)[k] - (mapping as any)[k]) > 1e-4)) useView.getState().set({ mapping, renderMs: r.stats.lastRenderMs });
  }

  private scheduleHisto() {
    clearTimeout(this.histoTimer);
    this.histoTimer = window.setTimeout(() => this.computeHisto(), 60);
  }

  private computeHisto() {
    const r = this.renderer;
    if (!r || !this.out) return;
    const { data } = r.readSmall(this.out, 220);
    const H: Histo = { r: new Uint32Array(256), g: new Uint32Array(256), b: new Uint32Array(256), l: new Uint32Array(256), clipHi: 0, clipLo: 0, total: 0 };
    const m = convertMatrix(SPACES.rec2020, SPACES.srgb);
    const enc = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 0.5) continue;
      const R = m[0] * data[i] + m[1] * data[i + 1] + m[2] * data[i + 2];
      const G = m[3] * data[i] + m[4] * data[i + 1] + m[5] * data[i + 2];
      const B = m[6] * data[i] + m[7] * data[i + 1] + m[8] * data[i + 2];
      if (Math.max(R, G, B) >= 0.999) H.clipHi++;
      if (Math.max(R, G, B) <= 0.002) H.clipLo++;
      const er = Math.round(Math.min(1, Math.max(0, enc(Math.max(R, 0)))) * 255), eg = Math.round(Math.min(1, Math.max(0, enc(Math.max(G, 0)))) * 255), eb = Math.round(Math.min(1, Math.max(0, enc(Math.max(B, 0)))) * 255);
      H.r[er]++; H.g[eg]++; H.b[eb]++;
      H.l[Math.round(0.2126 * er + 0.7152 * eg + 0.0722 * eb)]++;
      H.total++;
    }
    useView.getState().set({ histo: H });
  }

  /** Render the current edit small and store it as the catalog thumbnail/preview. */
  async storeThumbnail(photoId: number, edit: EditParams): Promise<Uint8Array | null> {
    const r = this.renderer;
    if (!r?.source || this.photo?.id !== photoId) return null;
    const rc = this.renderContext(edit);
    const g = computeGeometry(edit, r.source.width, r.source.height, rc.lens);
    const scale = Math.min(1, 1600 / Math.max(g.outW, g.outH));
    const out = r.render(edit, rc, { scale }, 'thumb');
    const px = r.readEncoded(out, 'srgb', 8) as Uint8Array;
    this.requestRender();
    return encodeJpeg(px, out.width, out.height);
  }
}

export async function encodeJpeg(rgb: Uint8Array, w: number, h: number, quality = 0.88): Promise<Uint8Array<ArrayBuffer>> {
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) { img.data[j] = rgb[i]; img.data[j + 1] = rgb[i + 1]; img.data[j + 2] = rgb[i + 2]; img.data[j + 3] = 255; }
  ctx.putImageData(img, 0, 0);
  const blob = await c.convertToBlob({ type: 'image/jpeg', quality });
  return new Uint8Array(await blob.arrayBuffer());
}

let instance: EngineHost | null = null;
export const host = () => (instance ??= new EngineHost());
