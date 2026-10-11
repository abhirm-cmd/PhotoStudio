/**
 * WebGL2 compositor for the program monitor. Draws each visible layer as a
 * transformed quad, grading it through its baked 3D LUT, with the same
 * placement math, fades and transitions as the FFmpeg export.
 */
import type { Lut3D } from '@shared/grade';

const VS = `#version 300 es
in vec2 a;
uniform vec2 uRes;      // canvas size in project px
uniform vec2 uCenter;   // layer center, project px
uniform vec2 uSize;     // layer size, project px
uniform float uRot;     // radians
uniform vec2 uFlip;
uniform vec4 uCrop;     // l t r b (source fractions)
out vec2 vUv;
void main() {
  vec2 p = (a - 0.5) * uSize;
  float c = cos(uRot), s = sin(uRot);
  p = vec2(p.x * c - p.y * s, p.x * s + p.y * c) + uCenter;
  vec2 clip = p / uRes * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  vec2 uv = mix(a, 1.0 - a, uFlip);
  vUv = vec2(mix(uCrop.x, 1.0 - uCrop.z, uv.x), mix(uCrop.y, 1.0 - uCrop.w, uv.y));
}`;

const FS = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 vUv;
uniform sampler2D uTex;
uniform sampler3D uLut;
uniform float uLutOn, uLutSize, uAlpha, uBlack, uPremul;
out vec4 o;
void main() {
  vec4 c = texture(uTex, vUv);
  if (uPremul > 0.5 && c.a > 0.0) c.rgb /= c.a;
  vec3 rgb = c.rgb;
  if (uLutOn > 0.5) {
    vec3 s = (clamp(rgb, 0.0, 1.0) * (uLutSize - 1.0) + 0.5) / uLutSize;
    rgb = texture(uLut, s).rgb;
  }
  rgb *= (1.0 - uBlack);
  float a = c.a * uAlpha;
  o = vec4(rgb * a, a);
}`;

export interface DrawLayer {
  source: TexImageSource;
  key: string;
  /** Re-upload even if the key is unchanged (video frames) */
  dynamic: boolean;
  center: [number, number];
  size: [number, number];
  rotation: number;
  flip: [boolean, boolean];
  crop: [number, number, number, number];
  alpha: number;
  black: number;
  lut: { key: string; lut: Lut3D } | null;
  premultiplied?: boolean;
}

export class Compositor {
  gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private texs = new Map<string, { tex: WebGLTexture; used: number }>();
  private luts = new Map<string, { tex: WebGLTexture; size: number; used: number }>();
  private frameNo = 0;
  width = 1920; height = 1080;

  constructor(public canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, alpha: false, preserveDrawingBuffer: true, antialias: false });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS));
    gl.bindAttribLocation(p, 0, 'a');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link');
    this.prog = p;
    for (const n of ['uRes', 'uCenter', 'uSize', 'uRot', 'uFlip', 'uCrop', 'uTex', 'uLut', 'uLutOn', 'uLutSize', 'uAlpha', 'uBlack', 'uPremul']) this.u[n] = gl.getUniformLocation(p, n);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  }

  /** Project size and the backing-store resolution (≤ project size). */
  resize(projW: number, projH: number, maxW: number) {
    this.width = projW; this.height = projH;
    const s = Math.min(1, maxW / projW);
    const w = Math.max(2, Math.round(projW * s)), h = Math.max(2, Math.round(projH * s));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
  }

  private texture(l: DrawLayer): WebGLTexture | null {
    const gl = this.gl;
    let t = this.texs.get(l.key);
    const fresh = !t;
    if (!t) {
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      t = { tex, used: 0 };
      this.texs.set(l.key, t);
    }
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    if (fresh || l.dynamic) {
      try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, l.source); }
      catch { return null; }
    }
    t.used = this.frameNo;
    return t.tex;
  }

  private lutTexture(key: string, lut: Lut3D): WebGLTexture {
    const gl = this.gl;
    let t = this.luts.get(key);
    if (!t) {
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_3D, tex);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      for (const w of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, w, gl.CLAMP_TO_EDGE);
      // Half-float RGB (filterable in WebGL2) with R varying fastest, the .cube layout
      const n = lut.size;
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16F, n, n, n, 0, gl.RGB, gl.FLOAT, lut.data);
      t = { tex, size: n, used: 0 };
      this.luts.set(key, t);
    }
    t.used = this.frameNo;
    return t.tex;
  }

  draw(layers: DrawLayer[]) {
    const gl = this.gl;
    this.frameNo++;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.prog);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
    gl.uniform2f(this.u.uRes, this.width, this.height);
    gl.uniform1i(this.u.uTex, 0);
    gl.uniform1i(this.u.uLut, 1);
    for (const l of layers) {
      if (l.alpha <= 0) continue;
      gl.activeTexture(gl.TEXTURE0);
      const tex = this.texture(l);
      if (!tex) continue;
      gl.activeTexture(gl.TEXTURE1);
      if (l.lut) { gl.bindTexture(gl.TEXTURE_3D, this.lutTexture(l.lut.key, l.lut.lut)); gl.uniform1f(this.u.uLutOn, 1); gl.uniform1f(this.u.uLutSize, l.lut.lut.size); }
      else { gl.bindTexture(gl.TEXTURE_3D, null); gl.uniform1f(this.u.uLutOn, 0); }
      gl.uniform2f(this.u.uCenter, l.center[0], l.center[1]);
      gl.uniform2f(this.u.uSize, l.size[0], l.size[1]);
      gl.uniform1f(this.u.uRot, (l.rotation * Math.PI) / 180);
      gl.uniform2f(this.u.uFlip, l.flip[0] ? 1 : 0, l.flip[1] ? 1 : 0);
      gl.uniform4f(this.u.uCrop, l.crop[0], l.crop[1], l.crop[2], l.crop[3]);
      gl.uniform1f(this.u.uAlpha, l.alpha);
      gl.uniform1f(this.u.uBlack, l.black);
      gl.uniform1f(this.u.uPremul, l.premultiplied ? 1 : 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    // Drop textures not used for a while
    if (this.frameNo % 120 === 0) {
      for (const [k, t] of this.texs) if (this.frameNo - t.used > 240) { gl.deleteTexture(t.tex); this.texs.delete(k); }
      for (const [k, t] of this.luts) if (this.frameNo - t.used > 600) { gl.deleteTexture(t.tex); this.luts.delete(k); }
    }
  }

  /** Forget a static texture (e.g. a title whose text changed). */
  invalidate(prefix: string) {
    for (const [k, t] of this.texs) if (k.startsWith(prefix)) { this.gl.deleteTexture(t.tex); this.texs.delete(k); }
  }

  dispose() {
    for (const t of this.texs.values()) this.gl.deleteTexture(t.tex);
    for (const t of this.luts.values()) this.gl.deleteTexture(t.tex);
    this.texs.clear(); this.luts.clear();
  }
}
