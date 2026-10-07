/**
 * The GPU render pipeline. One Renderer owns a WebGL2 context and a source image,
 * and can render the full edit at any scale, either whole (preview) or as tiles
 * (export / zoomed viewport). Low-frequency analysis (local-contrast pyramids,
 * dehaze) and masks are computed at fixed resolutions so previews and exports match.
 */
import { GLContext, type Program, type Tex } from './gl';
import * as S from './shaders';
import { computeGeometry, type GeometryInfo } from './geometry';
import { buildCurveLut, CURVE_LUT_SIZE } from './curves';
import { developUniforms, maskParamArray, MAX_MASKS } from './params';
import type { LensCorrection } from './lens';
import { defaultEdit, type EditParams, type Mask, type MaskComponent } from '@shared/edit';
import { convertMatrix, SPACES, IDENTITY, type Mat3 } from '@shared/color';
import { linearSrgbToOklab } from '@shared/color';

export interface SourceImage {
  id: string;
  kind: 'u16' | 'bitmap';
  width: number; height: number;
  data?: Uint16Array;
  bitmap?: ImageBitmap;
  primaries: 'prophoto' | 'srgb' | 'rec2020';
  transfer: 'linear' | 'srgb';
  isRaw: boolean;
  fullWidth: number; fullHeight: number;
  asShot: { temp: number; tint: number };
  /** Optional gain applied at decode (e.g. raw white level scaling) */
  gain?: number;
}

export interface MaskAsset { key: string; width: number; height: number; data: Uint8Array | ImageBitmap }

export interface RenderContext {
  lens: LensCorrection | null;
  assets: Map<string, MaskAsset>;
}

export interface RenderOptions {
  /** Output scale relative to source pixels (1 = source resolution). */
  scale: number;
  ignoreCrop?: boolean;
  /** Output-uv rectangle to render (defaults to the whole image) */
  region?: [number, number, number, number];
  /** Extra pixels around a region (tile margin) */
  margin?: number;
  /** Skip mask evaluation (used for the unedited "before" render) */
  noMasks?: boolean;
}

export interface RenderOutput { tex: Tex; width: number; height: number; fullW: number; fullH: number; margin: number; geometry: GeometryInfo }

const ANALYSIS_EDGE = 768;
const LARGE_EDGE = 192;

const INPUT_MATRICES: Record<string, Mat3> = {
  prophoto: convertMatrix(SPACES.prophoto, SPACES.rec2020),
  srgb: convertMatrix(SPACES.srgb, SPACES.rec2020),
  rec2020: IDENTITY,
};

export class Renderer {
  ctx: GLContext;
  private p: Record<string, Program> = {};
  private targets = new Map<string, Tex>();
  source: SourceImage | null = null;
  base: Tex | null = null;
  private curveTex: Tex;
  private curveKey = '';
  private analysisKey = '';
  private maskKey = '';
  private atmos = 1;
  private maskArr: Tex | null = null;
  private maskCount = 0;
  private brushTex = new Map<string, { key: string; tex: Tex }>();
  private assetTex = new Map<string, Tex>();
  private dummyArr: Tex;
  private brushVao: WebGLVertexArrayObject | null = null;
  private brushBuf: WebGLBuffer | null = null;
  lastGeometry: GeometryInfo | null = null;
  stats = { lastRenderMs: 0 };

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas) {
    this.ctx = new GLContext(canvas);
    const c = this.ctx;
    const prog = (name: string, fs: string, vs = S.VERT) => (this.p[name] = c.program(vs, fs, name));
    prog('decode16', S.DECODE_UINT16);
    prog('decode8', S.DECODE_RGBA8);
    prog('resample', S.RESAMPLE);
    prog('geometry', S.GEOMETRY);
    prog('denoise', S.DENOISE);
    prog('luma', S.LUMA_EXTRACT);
    prog('blur', S.BLUR);
    prog('maskComp', S.MASK_COMPONENT);
    prog('maskRefine', S.MASK_REFINE);
    prog('brush', S.BRUSH_FRAG, S.BRUSH_VERT);
    prog('develop', S.DEVELOP);
    prog('percLuma', S.PERC_LUMA);
    prog('sharpen', S.SHARPEN);
    prog('view', S.VIEW);
    prog('encode', S.ENCODE);
    this.curveTex = c.texture(CURVE_LUT_SIZE, 1, c.gl.RGBA16F);
    this.dummyArr = c.textureArray(1, 1, 1);
  }

  get gl() { return this.ctx.gl; }

  dispose() {
    for (const t of this.targets.values()) this.ctx.free(t);
    this.targets.clear();
    this.ctx.free(this.base);
    this.ctx.free(this.maskArr);
    for (const b of this.brushTex.values()) this.ctx.free(b.tex);
    for (const t of this.assetTex.values()) this.ctx.free(t);
    (this.gl.getExtension('WEBGL_lose_context'))?.loseContext();
  }

  /** Named render target, reallocated only if size/format changes. */
  private rt(name: string, w: number, h: number, fmt: number = this.gl.RGBA16F): Tex {
    const t = this.targets.get(name);
    if (t && t.w === w && t.h === h && t.format === fmt) return t;
    this.ctx.free(t);
    const n = this.ctx.texture(w, h, fmt);
    this.targets.set(name, n);
    return n;
  }

  /* ------------------------------------------------------------- source */

  setSource(src: SourceImage) {
    const gl = this.gl, c = this.ctx;
    this.ctx.free(this.base);
    this.base = null;
    this.analysisKey = this.maskKey = '';
    let w = src.width, h = src.height;
    const max = c.maxTexture;
    const input = INPUT_MATRICES[src.primaries];
    let raw: Tex;
    if (src.kind === 'u16') {
      if (w > max || h > max) throw new Error(`Image is larger than this GPU's texture limit (${max}px).`);
      raw = c.texture(w, h, gl.RGB16UI, gl.NEAREST);
      gl.bindTexture(gl.TEXTURE_2D, raw.tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 2);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGB_INTEGER, gl.UNSIGNED_SHORT, src.data!);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      const full = c.texture(w, h, gl.RGBA16F);
      c.target(full);
      this.p.decode16.use().set('uInput', input).set('uScale', (src.gain ?? 1) / 65535).set('uTransfer', src.transfer === 'srgb' ? 1 : 0).set('uRegion', [0, 0, 1, 1]).tex('uSrc', raw.tex);
      c.draw();
      c.free(raw);
      this.base = full;
    } else {
      raw = c.texture(w, h, gl.SRGB8_ALPHA8);
      gl.bindTexture(gl.TEXTURE_2D, raw.tex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, src.bitmap!);
      const full = c.texture(w, h, gl.RGBA16F);
      c.target(full);
      this.p.decode8.use().set('uInput', input).set('uRegion', [0, 0, 1, 1]).tex('uSrc', raw.tex);
      c.draw();
      c.free(raw);
      this.base = full;
    }
    c.unbindAll();
    this.source = src;
  }

  /* ------------------------------------------------------------ helpers */

  private geomUniforms(prog: Program, g: GeometryInfo) {
    prog.set('uSrcSize', [g.srcW, g.srcH]).set('uFrameSize', [g.frameW, g.frameH])
      .set('uCrop', [g.crop.x, g.crop.y, g.crop.w, g.crop.h]).set('uAngle', g.angle)
      .set('uHomInv', g.homInv).set('uLens', g.lens).set('uOrient', g.orient);
  }

  private geometryPass(dst: Tex, g: GeometryInfo, e: EditParams, lens: LensCorrection | null, region: number[]) {
    const c = this.ctx;
    c.target(dst);
    const p = this.p.geometry.use();
    this.geomUniforms(p, g);
    p.set('uRegion', region).set('uCA', [lens?.caR ?? 1, lens?.caB ?? 1])
      .set('uVig', [...(lens?.vig ?? [0, 0, 0]), e.optics.vignetting / 100]).set('uVigMid', e.optics.vignettingMidpoint / 100)
      .tex('uSrc', this.base!.tex);
    c.draw();
  }

  private blur(src: Tex, tmp: Tex, dst: Tex, sigma: number) {
    const c = this.ctx, p = this.p.blur.use();
    c.target(tmp);
    p.set('uRegion', [0, 0, 1, 1]).set('uDir', [1 / src.w, 0]).set('uSigma', sigma).tex('uSrc', src.tex);
    c.draw();
    c.target(dst);
    p.set('uDir', [0, 1 / tmp.h]).tex('uSrc', tmp.tex);
    c.draw();
  }

  private resample(src: Tex, dst: Tex, prog = this.p.resample) {
    const c = this.ctx;
    c.target(dst);
    prog.use().set('uRegion', [0, 0, 1, 1]).set('uTexel', [1 / src.w, 1 / src.h]).set('uRatio', [src.w / dst.w, src.h / dst.h]).tex('uSrc', src.tex);
    c.draw();
  }

  private fit(w: number, h: number, edge: number) {
    const k = Math.min(1, edge / Math.max(w, h));
    return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))];
  }

  /* ----------------------------------------------------------- analysis */

  private ensureAnalysis(e: EditParams, g: GeometryInfo, lens: LensCorrection | null) {
    const key = JSON.stringify([this.source?.id, e.crop, e.transform, e.optics, lens, g.outW, g.outH]);
    if (key === this.analysisKey) return;
    const [aw, ah] = this.fit(g.outW, g.outH, ANALYSIS_EDGE);
    const geoA = this.rt('a.geo', aw, ah);
    this.geometryPass(geoA, g, e, lens, [0, 0, 1, 1]);
    const lumA = this.rt('a.luma', aw, ah);
    this.resample(geoA, lumA, this.p.luma);
    const tmp = this.rt('a.tmp', aw, ah);
    this.blur(lumA, tmp, this.rt('a.mid', aw, ah), Math.max(1, 0.012 * Math.max(aw, ah)));
    const [lw, lh] = this.fit(aw, ah, LARGE_EDGE);
    const lumL = this.rt('a.lumaL', lw, lh);
    this.resample(lumA, lumL);
    this.blur(lumL, this.rt('a.tmpL', lw, lh), this.rt('a.large', lw, lh), Math.max(1, 0.05 * Math.max(lw, lh)));
    // Atmospheric light ≈ 99.5th percentile luminance of the analysis image
    const px = new Float32Array(lw * lh * 4);
    this.ctx.target(lumL);
    this.gl.readPixels(0, 0, lw, lh, this.gl.RGBA, this.gl.FLOAT, px);
    const lums: number[] = [];
    for (let i = 0; i < px.length; i += 4) lums.push(px[i]);
    lums.sort((a, b) => a - b);
    this.atmos = Math.min(1.5, Math.max(0.2, Math.pow(2, lums[Math.floor(lums.length * 0.995)] ?? 0)));
    this.analysisKey = key;
    this.ctx.unbindAll();
  }

  /* -------------------------------------------------------------- masks */

  private maskEdge(g: GeometryInfo, scale: number) {
    return Math.min(2048, Math.max(512, Math.round(Math.max(g.outW, g.outH) * Math.min(1, scale))));
  }

  private ensureMasks(e: EditParams, g: GeometryInfo, lens: LensCorrection | null, rc: RenderContext, scale: number) {
    const masks = e.masks.slice(0, MAX_MASKS);
    const portraitLayers = this.portraitLayers(e, rc);
    const strip = masks.map(m => ({ c: m.components, i: m.invert, f: m.feather, r: m.refine }));
    const edge = this.maskEdge(g, scale);
    const key = JSON.stringify([this.analysisKey, strip, portraitLayers.map(l => l.key), edge]);
    if (key === this.maskKey) return;
    const total = masks.length + portraitLayers.length;
    this.maskCount = masks.length;
    if (!total) { this.ctx.free(this.maskArr); this.maskArr = null; this.maskKey = key; return; }
    const [mw, mh] = this.fit(g.outW, g.outH, edge);
    if (!this.maskArr || this.maskArr.w !== mw || this.maskArr.h !== mh || this.maskArr.layers !== total) {
      this.ctx.free(this.maskArr);
      this.maskArr = this.ctx.textureArray(mw, mh, total);
    }
    const geoM = this.rt('m.geo', mw, mh);
    this.geometryPass(geoM, g, e, lens, [0, 0, 1, 1]);
    masks.forEach((m, i) => this.renderMask(m, i, g, geoM, mw, mh, rc));
    portraitLayers.forEach((l, j) => this.renderMask(l.mask, masks.length + j, g, geoM, mw, mh, rc));
    this.maskKey = key;
    this.ctx.unbindAll();
  }

  /** Portrait tools reuse AI masks (skin / eyes / teeth) as hidden layers. */
  private portraitLayers(e: EditParams, rc: RenderContext): { key: string; kind: 'skin' | 'eyes' | 'teeth'; mask: Mask }[] {
    const p = e.portrait;
    const out: { key: string; kind: 'skin' | 'eyes' | 'teeth'; mask: Mask }[] = [];
    const add = (kind: 'skin' | 'eyes' | 'teeth', on: boolean) => {
      if (!on) return;
      const ref = [...rc.assets.keys()].find(k => k.endsWith(`:${kind}`));
      if (!ref) return;
      out.push({ key: ref, kind, mask: { id: `portrait-${kind}`, name: kind, visible: true, invert: false, density: 100, feather: kind === 'skin' ? 10 : 4, refine: 0, adjust: {} as any, components: [{ id: kind, type: 'ai', op: 'add', invert: false, target: kind, ref, provider: 'portrait' }] } });
    };
    add('skin', !!(p.skinSmoothing || p.skinTone || p.skinEvenness || p.faceLight));
    add('eyes', !!p.eyeEnhance);
    add('teeth', !!p.teethWhitening);
    return out;
  }

  private renderMask(m: Mask, layer: number, g: GeometryInfo, geoM: Tex, mw: number, mh: number, rc: RenderContext) {
    const gl = this.gl, c = this.ctx;
    const acc = this.rt('m.acc', mw, mh, gl.R16F);
    c.target(acc);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const comps = m.components.length ? m.components : [{ id: 'all', type: 'all', op: 'add', invert: false } as MaskComponent];
    comps.forEach((comp, idx) => {
      let texSrc: Tex | null = null;
      if (comp.type === 'brush') texSrc = this.brushTexture(comp);
      if (comp.type === 'ai') texSrc = this.assetTexture(comp.ref, rc);
      c.target(acc);
      const p = this.p.maskComp.use();
      this.geomUniforms(p, g);
      p.set('uRegion', [0, 0, 1, 1]);
      const typeId = { all: 0, linear: 1, radial: 2, brush: 3, ai: 3, color: 4, luminance: 5 }[comp.type];
      p.set('uType', typeId).set('uInvert', comp.invert).set('uOp', comp.op === 'subtract' ? 1 : 0);
      if (comp.type === 'linear') p.set('uA', [comp.a[0], comp.a[1], comp.b[0], comp.b[1]]);
      if (comp.type === 'radial') p.set('uA', [comp.cx, comp.cy, comp.rx, comp.ry]).set('uB', [comp.angle * Math.PI / 180, comp.feather / 100, 0, 0]);
      if (comp.type === 'luminance') p.set('uB', [comp.min, comp.max, Math.max(0.005, comp.feather / 100 * 0.25), 0]);
      if (comp.type === 'color') {
        const labs = comp.samples.slice(0, 8).map(s => linearSrgbToOklab([s[0] / (1 + s[0]), s[1] / (1 + s[1]), s[2] / (1 + s[2])]));
        while (labs.length < 8) labs.push([0, 0, 0]);
        p.set('uSamples', labs.flat()).set('uSampleCount', Math.min(8, comp.samples.length)).set('uRange', comp.range / 100);
      }
      p.tex('uTex', texSrc?.tex ?? null).tex('uImage', geoM.tex);
      const op = comp.op;
      gl.enable(gl.BLEND);
      if (idx === 0 && op !== 'add') {
        // Starting with subtract/intersect from an empty mask yields empty; nothing to draw.
        gl.disable(gl.BLEND);
        return;
      }
      gl.blendEquation(op === 'add' ? gl.MAX : gl.MIN);
      c.draw();
      gl.disable(gl.BLEND);
    });
    // Global feather
    let src = acc;
    if (m.feather > 0) {
      const tmp = this.rt('m.tmp', mw, mh, gl.R16F), out = this.rt('m.feather', mw, mh, gl.R16F);
      this.blur(acc, tmp, out, (m.feather / 100) * 0.04 * Math.max(mw, mh));
      src = out;
    }
    c.target(this.maskArr!, layer);
    this.p.maskRefine.use().set('uRegion', [0, 0, 1, 1]).set('uTexel', [1 / mw, 1 / mh]).set('uRefine', m.refine / 100).set('uInvert', m.invert)
      .tex('uMask', src.tex).tex('uImage', geoM.tex);
    c.draw();
    c.unbindAll();
  }

  private brushTexture(comp: Extract<MaskComponent, { type: 'brush' }>): Tex {
    const gl = this.gl, c = this.ctx;
    const src = this.source!;
    const key = `${src.id}:${comp.dabs.length}:${comp.dabs.length ? JSON.stringify(comp.dabs[comp.dabs.length - 1]) : ''}`;
    const cached = this.brushTex.get(comp.id);
    if (cached && cached.key === key) return cached.tex;
    const [bw, bh] = this.fit(src.width, src.height, 2048);
    const tex = cached?.tex.w === bw && cached.tex.h === bh ? cached.tex : c.texture(bw, bh, gl.RGBA8);
    if (cached && cached.tex !== tex) c.free(cached.tex);
    c.target(tex);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!this.brushVao) {
      this.brushVao = gl.createVertexArray();
      this.brushBuf = gl.createBuffer();
    }
    const p = this.p.brush.use();
    const long = Math.max(bw, bh);
    p.set('uAspect', [long / bw, long / bh]);
    gl.bindVertexArray(this.brushVao);
    // quad corners (instanced)
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(0, 0);
    const locDab = p.attribs.get('aDab')!, locF = p.attribs.get('aFeather')!;
    gl.enable(gl.BLEND);
    // Draw runs of add / erase dabs in order
    let i = 0;
    while (i < comp.dabs.length) {
      const erase = comp.dabs[i].erase;
      let j = i;
      while (j < comp.dabs.length && comp.dabs[j].erase === erase) j++;
      const run = comp.dabs.slice(i, j);
      const data = new Float32Array(run.length * 5);
      run.forEach((d, k) => data.set([d.x, d.y, d.r, d.flow, d.feather], k * 5));
      gl.bindBuffer(gl.ARRAY_BUFFER, this.brushBuf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(locDab);
      gl.vertexAttribPointer(locDab, 4, gl.FLOAT, false, 20, 0);
      gl.vertexAttribDivisor(locDab, 1);
      gl.enableVertexAttribArray(locF);
      gl.vertexAttribPointer(locF, 1, gl.FLOAT, false, 20, 16);
      gl.vertexAttribDivisor(locF, 1);
      gl.blendEquation(gl.FUNC_ADD);
      if (erase) gl.blendFunc(gl.ZERO, gl.ONE_MINUS_SRC_ALPHA); else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, run.length);
      i = j;
    }
    gl.disable(gl.BLEND);
    gl.vertexAttribDivisor(locDab, 0);
    gl.vertexAttribDivisor(locF, 0);
    gl.bindVertexArray(null);
    gl.deleteBuffer(quad);
    this.brushTex.set(comp.id, { key, tex });
    return tex;
  }

  private assetTexture(ref: string, rc: RenderContext): Tex | null {
    const cached = this.assetTex.get(ref);
    if (cached) return cached;
    const a = rc.assets.get(ref);
    if (!a) return null;
    const gl = this.gl, c = this.ctx;
    const t = c.texture(a.width, a.height, gl.RGBA8);
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    if (a.data instanceof Uint8Array) {
      const rgba = a.data.length === a.width * a.height ? expandGray(a.data) : a.data;
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, a.width, a.height, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    } else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, a.data);
    this.assetTex.set(ref, t);
    return t;
  }

  invalidateAsset(ref: string) { const t = this.assetTex.get(ref); if (t) { this.ctx.free(t); this.assetTex.delete(ref); } this.maskKey = ''; }

  /* ------------------------------------------------------------- render */

  /**
   * Render an edit. Returns a texture containing the requested region
   * (plus margin) in display-referred linear Rec.2020.
   */
  render(e: EditParams, rc: RenderContext, o: RenderOptions, target = 'out'): RenderOutput {
    if (!this.base || !this.source) throw new Error('No source image');
    const t0 = performance.now();
    const gl = this.gl, c = this.ctx;
    const src = this.source;
    const g = computeGeometry(e, src.width, src.height, rc.lens, { ignoreCrop: o.ignoreCrop });
    this.lastGeometry = g;
    this.ensureAnalysis(e, g, rc.lens);
    if (!o.noMasks) this.ensureMasks(e, g, rc.lens, rc, o.scale);

    // Curve LUT
    const ck = JSON.stringify(e.curve);
    if (ck !== this.curveKey) {
      gl.bindTexture(gl.TEXTURE_2D, this.curveTex.tex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, CURVE_LUT_SIZE, 1, gl.RGBA, gl.FLOAT, buildCurveLut(e.curve));
      this.curveKey = ck;
    }

    const fullW = Math.max(1, Math.round(g.outW * o.scale)), fullH = Math.max(1, Math.round(g.outH * o.scale));
    const region = o.region ?? [0, 0, 1, 1];
    const margin = o.margin ?? 0;
    const rw = Math.max(1, Math.round(region[2] * fullW)) + 2 * margin;
    const rh = Math.max(1, Math.round(region[3] * fullH)) + 2 * margin;
    const reg = [region[0] - margin / fullW, region[1] - margin / fullH, rw / fullW, rh / fullH];
    const pxScale = (o.scale * src.width) / src.fullWidth;

    const masks = (!o.noMasks && this.maskArr?.tex) || this.dummyArr.tex;
    const bindMasks = (p: Program) => p.tex('uMasks', masks, gl.TEXTURE_2D_ARRAY);

    // 1. geometry
    const geo = this.rt(`${target}.geo`, rw, rh);
    this.geometryPass(geo, g, e, rc.lens, reg);

    // 2. noise reduction
    let work = geo;
    const nrLocal = maskParamArray(e, 'noise');
    const nrActive = e.detail.noiseReduction > 0 || e.detail.colorNoiseReduction > 0 || nrLocal.uMaskParam.some(v => v > 0);
    if (nrActive) {
      const nr = this.rt(`${target}.nr`, rw, rh);
      c.target(nr);
      const p = this.p.denoise.use();
      p.set('uRegion', reg).set('uTexel', [1 / rw, 1 / rh]).set('uLuma', e.detail.noiseReduction / 100).set('uDetail', e.detail.noiseDetail / 100)
        .set('uChroma', e.detail.colorNoiseReduction / 100).set('uPxScale', Math.min(1, pxScale))
        .set('uMaskCount', nrLocal.uMaskCount).set('uMaskDensity', nrLocal.uMaskDensity).set('uMaskParam', nrLocal.uMaskParam).tex('uSrc', geo.tex);
      bindMasks(p);
      c.draw();
      c.unbindAll();
      work = nr;
    }

    // 3. fine luminance blur (texture)
    const fine = this.rt(`${target}.fine`, rw, rh, gl.R16F);
    const fineTmp = this.rt(`${target}.fineTmp`, rw, rh, gl.R16F);
    c.target(fine);
    this.p.luma.use().set('uRegion', [0, 0, 1, 1]).set('uTexel', [1 / rw, 1 / rh]).set('uRatio', [1, 1]).tex('uSrc', work.tex);
    c.draw();
    const fine2 = this.rt(`${target}.fine2`, rw, rh, gl.R16F);
    this.blur(fine, fineTmp, fine2, Math.max(0.8, 3.0 * pxScale));

    // 4. develop
    const dev = this.rt(`${target}.dev`, rw, rh);
    c.target(dev);
    const dp = this.p.develop.use();
    const u = developUniforms(e, { isRaw: src.isRaw, asShot: src.asShot, outW: fullW, outH: fullH, pxScale, atmos: this.atmos, grainSeed: 13.7 });
    for (const [k, v] of Object.entries(u)) dp.set(k, v);
    const pl = o.noMasks ? [] : this.portraitLayers(e, rc);
    const layerOf = (kind: string) => { const i = pl.findIndex(l => l.kind === kind); return i < 0 ? -1 : this.maskCount + i; };
    dp.set('uRegion', reg).set('uPortraitMask', layerOf('skin')).set('uEyeMask', layerOf('eyes')).set('uTeethMask', layerOf('teeth'));
    dp.tex('uSrc', work.tex).tex('uFine', fine2.tex).tex('uMid', this.targets.get('a.mid')!.tex).tex('uLarge', this.targets.get('a.large')!.tex).tex('uCurve', this.curveTex.tex);
    bindMasks(dp);
    c.draw();
    c.unbindAll();

    // 5. sharpen (+ skin smoothing as negative local sharpening on skin layer is handled in develop via texture)
    let out = dev;
    const shLocal = maskParamArray(e, 'sharpness');
    if (e.detail.sharpenAmount > 0 || shLocal.uMaskParam.some(v => v !== 0) || e.portrait.skinSmoothing > 0) {
      const yl = this.rt(`${target}.y`, rw, rh, gl.R16F);
      c.target(yl);
      this.p.percLuma.use().set('uRegion', [0, 0, 1, 1]).tex('uSrc', dev.tex);
      c.draw();
      const yb = this.rt(`${target}.yb`, rw, rh, gl.R16F);
      this.blur(yl, fineTmp, yb, Math.max(0.5, e.detail.sharpenRadius * Math.min(1, pxScale * 1.5)));
      const sh = this.rt(`${target}.sharp`, rw, rh);
      c.target(sh);
      const sp = this.p.sharpen.use();
      // Skin smoothing: negative sharpening (detail removal) restricted to the skin layer.
      const skin = layerOf('skin');
      const params = Float32Array.from(shLocal.uMaskParam);
      const dens = Float32Array.from(shLocal.uMaskDensity);
      let count = shLocal.uMaskCount;
      if (skin >= 0 && e.portrait.skinSmoothing > 0 && skin < MAX_MASKS) { params[skin] = -e.portrait.skinSmoothing * 1.4; dens[skin] = 1; count = Math.max(count, skin + 1); }
      sp.set('uRegion', reg).set('uTexel', [1 / rw, 1 / rh]).set('uAmount', (e.detail.sharpenAmount / 150) * Math.min(1, 0.4 + pxScale))
        .set('uDetail', e.detail.sharpenDetail / 100).set('uMasking', e.detail.sharpenMasking / 100)
        .set('uMaskCount', count).set('uMaskDensity', dens).set('uMaskParam', params)
        .tex('uSrc', dev.tex).tex('uBlur', yb.tex);
      bindMasks(sp);
      c.draw();
      c.unbindAll();
      out = sh;
    }
    gl.finish?.();
    this.stats.lastRenderMs = performance.now() - t0;
    return { tex: out, width: rw, height: rh, fullW, fullH, margin, geometry: g };
  }

  /** Render the unedited "before" image with the same geometry (for split comparisons). */
  renderBefore(e: EditParams, rc: RenderContext, o: RenderOptions): RenderOutput {
    const d = defaultEdit(this.source!.isRaw);
    d.crop = e.crop; d.transform = e.transform; d.optics = e.optics;
    d.wb = { ...d.wb, temp: this.source!.asShot.temp, tint: this.source!.asShot.tint };
    return this.render(d, { ...rc, assets: new Map() }, { ...o, noMasks: true }, 'before');
  }

  /* --------------------------------------------------------------- draw */

  draw(after: Tex, before: Tex | null, view: ViewState) {
    const gl = this.gl, c = this.ctx;
    c.target(null);
    const p = this.p.view.use();
    p.set('uRegion', [0, 0, 1, 1]).set('uViewInv', view.viewInv).set('uCanvas', [gl.drawingBufferWidth, gl.drawingBufferHeight])
      .set('uMode', before ? view.mode : 0).set('uSplit', view.split).set('uClipping', view.clipping)
      .set('uOverlayMask', view.overlayMask ?? -1).set('uOverlayColor', view.overlayColor ?? [0.95, 0.25, 0.3]).set('uOverlayOpacity', view.overlayOpacity ?? 0.5)
      .set('uOutput', view.output).set('uBg', view.bg)
      .tex('uAfter', after.tex).tex('uBefore', (before ?? after).tex).tex('uMasks', this.maskArr?.tex ?? this.dummyArr.tex, gl.TEXTURE_2D_ARRAY);
    c.draw();
    c.unbindAll();
  }

  /** Encode a region of a render to 8/16-bit RGB in the given color space. */
  readEncoded(r: RenderOutput, space: string, bits: 8 | 16, linear = false, crop?: { x: number; y: number; w: number; h: number }): Uint8Array | Uint16Array {
    const gl = this.gl, c = this.ctx;
    const sp = SPACES[space] ?? SPACES.srgb;
    const enc = this.rt('enc', r.width, r.height, gl.RGBA16F);
    c.target(enc);
    const transfer = linear ? 0 : sp.gamma === 'srgb' ? 1 : 2;
    this.p.encode.use().set('uRegion', [0, 0, 1, 1]).set('uOutput', convertMatrix(SPACES.rec2020, sp)).set('uTransfer', transfer)
      .set('uGamma', typeof sp.gamma === 'number' ? sp.gamma : 2.2).set('uFill', [0, 0, 0]).tex('uSrc', r.tex.tex);
    c.draw();
    const cx = crop?.x ?? 0, cy = crop?.y ?? 0, cw = crop?.w ?? r.width, ch = crop?.h ?? r.height;
    const f = new Float32Array(cw * ch * 4);
    gl.readPixels(cx, cy, cw, ch, gl.RGBA, gl.FLOAT, f);
    c.unbindAll();
    const out = bits === 16 ? new Uint16Array(cw * ch * 3) : new Uint8Array(cw * ch * 3);
    const max = bits === 16 ? 65535 : 255;
    for (let i = 0, j = 0; i < f.length; i += 4, j += 3) {
      out[j] = Math.round(Math.min(1, Math.max(0, f[i])) * max);
      out[j + 1] = Math.round(Math.min(1, Math.max(0, f[i + 1])) * max);
      out[j + 2] = Math.round(Math.min(1, Math.max(0, f[i + 2])) * max);
    }
    return out;
  }

  /** Downsampled linear display-referred pixels (Float32 RGBA) for histograms & analysis. */
  readSmall(r: RenderOutput | Tex, edge = 256): { w: number; h: number; data: Float32Array } {
    const tex = 'tex' in r && 'geometry' in r ? (r as RenderOutput).tex : (r as Tex);
    const [w, h] = this.fit(tex.w, tex.h, edge);
    const small = this.rt(`small${edge}`, w, h);
    this.resample(tex, small);
    const data = new Float32Array(w * h * 4);
    this.gl.readPixels(0, 0, w, h, this.gl.RGBA, this.gl.FLOAT, data);
    this.ctx.unbindAll();
    return { w, h, data };
  }

  /** Read the scene-linear geometry output (pre-develop) at small size — used by auto WB/tone & eyedropper. */
  readSceneSmall(e: EditParams, rc: RenderContext, edge = 384): { w: number; h: number; data: Float32Array } {
    const src = this.source!;
    const g = computeGeometry(e, src.width, src.height, rc.lens);
    const [w, h] = this.fit(g.outW, g.outH, edge);
    const t = this.rt(`scene${edge}`, w, h);
    this.geometryPass(t, g, e, rc.lens, [0, 0, 1, 1]);
    const data = new Float32Array(w * h * 4);
    this.gl.readPixels(0, 0, w, h, this.gl.RGBA, this.gl.FLOAT, data);
    this.ctx.unbindAll();
    return { w, h, data };
  }

  /** Mask layer readback (for mask previews / tests). */
  get maskLayerCount() { return this.maskArr?.layers ?? 0; }
  get atmosphere() { return this.atmos; }
}

function expandGray(g: Uint8Array): Uint8Array {
  const out = new Uint8Array(g.length * 4);
  for (let i = 0; i < g.length; i++) { out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = g[i]; out[i * 4 + 3] = 255; }
  return out;
}

export interface ViewState {
  viewInv: Mat3;
  mode: 0 | 1 | 2 | 3;
  split: number;
  clipping: boolean;
  overlayMask?: number;
  overlayColor?: [number, number, number];
  overlayOpacity?: number;
  output: Mat3;
  bg: [number, number, number];
}
