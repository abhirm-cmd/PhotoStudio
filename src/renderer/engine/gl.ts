/** Thin WebGL2 helpers: programs with reflected uniforms, textures, framebuffers. */

export type GL = WebGL2RenderingContext;

export class Program {
  prog: WebGLProgram;
  uniforms = new Map<string, { loc: WebGLUniformLocation; type: number; size: number }>();
  attribs = new Map<string, number>();
  private units = new Map<string, number>();

  constructor(private gl: GL, vs: string, fs: string, public name: string) {
    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(sh);
        const numbered = src.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n');
        throw new Error(`Shader compile error in ${name}: ${log}\n${numbered.slice(0, 20000)}`);
      }
      return sh;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, 'aPos'); // the shared fullscreen VAO feeds location 0
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`Link error in ${name}: ${gl.getProgramInfoLog(p)}`);
    this.prog = p;
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    let unit = 0;
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i)!;
      const name = info.name.replace(/\[0\]$/, '');
      const loc = gl.getUniformLocation(p, info.name)!;
      this.uniforms.set(name, { loc, type: info.type, size: info.size });
      if (isSampler(gl, info.type)) this.units.set(name, unit++);
    }
    const na = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES);
    for (let i = 0; i < na; i++) { const a = gl.getActiveAttrib(p, i)!; this.attribs.set(a.name, gl.getAttribLocation(p, a.name)); }
  }

  use() { this.gl.useProgram(this.prog); return this; }

  set(name: string, v: any) {
    const u = this.uniforms.get(name);
    if (!u) return this; // optimized out — fine
    const gl = this.gl;
    switch (u.type) {
      case gl.FLOAT: Array.isArray(v) || ArrayBuffer.isView(v) ? gl.uniform1fv(u.loc, v as any) : gl.uniform1f(u.loc, v); break;
      case gl.FLOAT_VEC2: gl.uniform2fv(u.loc, flat(v)); break;
      case gl.FLOAT_VEC3: gl.uniform3fv(u.loc, flat(v)); break;
      case gl.FLOAT_VEC4: gl.uniform4fv(u.loc, flat(v)); break;
      case gl.INT: case gl.BOOL: Array.isArray(v) ? gl.uniform1iv(u.loc, v) : gl.uniform1i(u.loc, typeof v === 'boolean' ? (v ? 1 : 0) : v); break;
      case gl.FLOAT_MAT2: gl.uniformMatrix2fv(u.loc, false, colMajor(v, 2)); break;
      case gl.FLOAT_MAT3: gl.uniformMatrix3fv(u.loc, false, colMajor(v, 3)); break;
      default: throw new Error(`Unsupported uniform type for ${name}`);
    }
    return this;
  }

  /** Bind a texture to the sampler uniform `name`. */
  tex(name: string, tex: WebGLTexture | null, target: number = this.gl.TEXTURE_2D) {
    const unit = this.units.get(name);
    if (unit === undefined) return this;
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(target, tex);
    gl.uniform1i(this.uniforms.get(name)!.loc, unit);
    return this;
  }

  /** Bind placeholder textures for every sampler not explicitly set (avoids feedback/undefined reads). */
  unitFor(name: string) { return this.units.get(name); }
  samplerNames() { return [...this.units.keys()]; }
}

function isSampler(gl: GL, t: number) {
  return t === gl.SAMPLER_2D || t === gl.SAMPLER_2D_ARRAY || t === gl.UNSIGNED_INT_SAMPLER_2D || t === gl.SAMPLER_3D || t === gl.INT_SAMPLER_2D;
}
const flat = (v: any) => (Array.isArray(v) && Array.isArray(v[0]) ? v.flat() : v);
function colMajor(m: number[], n: number) {
  const out = new Float32Array(n * n);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) out[c * n + r] = m[r * n + c];
  return out;
}

export interface Tex { tex: WebGLTexture; w: number; h: number; format: number; layers?: number }

export class GLContext {
  gl: GL;
  quad: WebGLVertexArrayObject;
  private fbos = new WeakMap<WebGLTexture, WebGLFramebuffer>();
  readonly maxTexture: number;
  readonly floatBlend: boolean;

  constructor(public canvas: HTMLCanvasElement | OffscreenCanvas) {
    const gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true, alpha: false, powerPreference: 'high-performance' }) as GL | null;
    if (!gl) throw new Error('WebGL2 is not available. GPU acceleration is required for the render engine.');
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('This GPU does not support floating-point render targets (EXT_color_buffer_float).');
    gl.getExtension('OES_texture_float_linear');
    this.floatBlend = !!gl.getExtension('EXT_float_blend');
    this.gl = gl;
    this.maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.quad = vao;
  }

  program(vs: string, fs: string, name: string) {
    return new Program(this.gl, vs, fs, name);
  }

  texture(w: number, h: number, internal: number = this.gl.RGBA16F, filter: number = this.gl.LINEAR): Tex {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, internal, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return { tex, w, h, format: internal };
  }

  textureArray(w: number, h: number, layers: number, internal: number = this.gl.R16F): Tex {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, internal, w, h, Math.max(1, layers));
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return { tex, w, h, format: internal, layers: Math.max(1, layers) };
  }

  free(t: Tex | null | undefined) { if (t) { const fb = this.fbos.get(t.tex); if (fb) this.gl.deleteFramebuffer(fb); this.gl.deleteTexture(t.tex); } }

  /** Bind `t` as the render target (optionally a layer of an array texture). */
  target(t: Tex | null, layer?: number) {
    const gl = this.gl;
    if (!t) { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight); return; }
    let fb: WebGLFramebuffer | undefined;
    if (layer === undefined) {
      fb = this.fbos.get(t.tex);
      if (!fb) { fb = gl.createFramebuffer()!; gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0); this.fbos.set(t.tex, fb); }
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    } else {
      if (!this.layerFbo) this.layerFbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.layerFbo);
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, t.tex, 0, layer);
    }
    gl.viewport(0, 0, t.w, t.h);
  }
  private layerFbo: WebGLFramebuffer | null = null;

  draw() {
    const gl = this.gl;
    gl.bindVertexArray(this.quad);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  /** Unbind all texture units to avoid feedback loops between passes. */
  unbindAll(units = 12) {
    const gl = this.gl;
    for (let i = 0; i < units; i++) { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, null); gl.bindTexture(gl.TEXTURE_2D_ARRAY, null); }
  }
}
