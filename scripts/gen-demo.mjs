/**
 * Generates the demo photo set in resources/demo.
 *
 * The scenes are procedurally rendered (no third-party photos are bundled), so
 * they are free to ship. Each is a 2400×1600 JPEG with plausible EXIF and enough
 * texture, tonal range and colour for the editing tools to have something to do.
 */
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve(import.meta.dirname, '..', 'resources', 'demo');
const W = 2400, H = 1600;

/* ---------------------------------------------------------------- helpers */
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function makeNoise(seed, cells) {
  const r = rng(seed); const g = new Float32Array((cells + 1) * (cells + 1)).map(() => r());
  // Tileable lattice: coordinates outside [0,1) wrap around
  const at = (x, y) => g[(y % cells) * (cells + 1) + (x % cells)];
  return (u, v) => {
    const x = (((u % 1) + 1) % 1) * cells, y = (((v % 1) + 1) % 1) * cells, xi = Math.floor(x), yi = Math.floor(y);
    const fx = x - xi, fy = y - yi, sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = at(xi, yi) + (at(xi + 1, yi) - at(xi, yi)) * sx, b = at(xi, yi + 1) + (at(xi + 1, yi + 1) - at(xi, yi + 1)) * sx;
    return a + (b - a) * sy;
  };
}
function fbm(seed, octaves = 5, base = 4) {
  const ns = Array.from({ length: octaves }, (_, i) => makeNoise(seed + i * 97, base << i));
  return (u, v) => { let s = 0, a = 0.5, n = 0; for (const f of ns) { s += f(u, v) * a; n += a; a *= 0.5; } return s / n; };
}
const mix = (a, b, t) => a.map((x, i) => x + (b[i] - x) * t);
const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };

async function render(name, fn, exif) {
  const buf = Buffer.alloc(W * H * 3);
  const grain = rng(name.length * 7919);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = fn(x / W, y / H);
      const n = (grain() - 0.5) * 0.018;
      const i = (y * W + x) * 3;
      // scene values are linear-ish; encode with gamma 2.2 for sRGB-like JPEG
      for (let k = 0; k < 3; k++) buf[i + k] = Math.round(clamp(Math.pow(clamp(c[k]), 1 / 2.2) + n) * 255);
    }
  }
  const file = path.join(OUT, `${name}.jpg`);
  await sharp(buf, { raw: { width: W, height: H, channels: 3 } })
    .jpeg({ quality: 92, chromaSubsampling: '4:4:4' })
    .withExifMerge({ IFD0: { Make: exif.make, Model: exif.model, Artist: 'Lumora Studio demo', Copyright: 'Generated demo image, free to use', DateTime: exif.date }, IFD2: { ExposureTime: exif.shutter, FNumber: String(exif.f), ISOSpeedRatings: String(exif.iso), FocalLength: String(exif.focal), DateTimeOriginal: exif.date, LensModel: exif.lens } })
    .toFile(file);
  console.log('wrote', path.relative(process.cwd(), file));
}

/* ----------------------------------------------------------------- scenes */
const scenes = {
  'golden-coast': (() => {
    const clouds = fbm(11, 5, 3), waves = fbm(12, 4, 6), sand = fbm(13, 5, 8);
    return (u, v) => {
      const horizon = 0.56;
      if (v < horizon) {
        const t = v / horizon;
        let c = mix([0.08, 0.16, 0.42], [1.0, 0.52, 0.2], Math.pow(t, 1.6));
        const d = Math.hypot((u - 0.68) * 1.5, v - 0.47);
        c = c.map((x, i) => x + [1.4, 0.95, 0.45][i] * Math.exp(-d * d * 220) + [0.5, 0.25, 0.05][i] * Math.exp(-d * 9));
        const cl = smooth(0.52, 0.72, clouds(u * 1.8, v * 4));
        return mix(c, [0.95, 0.55, 0.38].map(x => x * (0.5 + t * 0.6)), cl * 0.6);
      }
      if (v < 0.8) {
        const t = (v - horizon) / 0.24;
        let c = mix([0.5, 0.3, 0.2], [0.03, 0.08, 0.14], Math.pow(t, 0.5));
        const glint = Math.exp(-Math.pow((u - 0.68) * 6, 2)) * smooth(0.55, 0.8, waves(u * 2, v * 30)) * (1 - t);
        return c.map((x, i) => x + glint * [1.2, 0.7, 0.3][i]);
      }
      const s = sand(u * 3, v * 3);
      return [0.42, 0.3, 0.2].map(x => x * (0.55 + s * 0.6) * (0.6 + (v - 0.8) * 1.5));
    };
  })(),
  'forest-trail': (() => {
    const leaves = fbm(21, 6, 6), light = fbm(22, 3, 2), path_ = fbm(23, 4, 5);
    return (u, v) => {
      const l = leaves(u, v), sun = smooth(0.45, 0.85, light(u, v));
      const trail = Math.exp(-Math.pow((u - 0.5 - (v - 1) * 0.25) / (0.04 + v * 0.18), 2)) * smooth(0.45, 1, v);
      let c = mix([0.02, 0.05, 0.015], [0.18, 0.36, 0.06], l);
      c = c.map((x, i) => x * (0.5 + sun * 1.6) + sun * [0.08, 0.06, 0.0][i]);
      const dirt = [0.32, 0.22, 0.12].map(x => x * (0.5 + path_(u * 2, v * 2) * 0.8) * (0.6 + sun));
      const mist = smooth(0.15, 0.45, 1 - Math.abs(v - 0.35) * 2) * 0.15;
      return mix(mix(c, dirt, trail), [0.7, 0.75, 0.7], mist);
    };
  })(),
  'city-dusk': (() => {
    const r = rng(31), bld = Array.from({ length: 34 }, (_, i) => ({ x: i / 34 + (r() - 0.5) * 0.01, w: 0.022 + r() * 0.025, h: 0.25 + r() * 0.5, seed: r() }));
    const win = makeNoise(32, 400);
    return (u, v) => {
      let c = mix([0.02, 0.03, 0.12], [0.6, 0.25, 0.25], smooth(0.1, 0.75, v));
      for (const b of bld) {
        if (u >= b.x && u < b.x + b.w && v > 1 - b.h) {
          c = [0.015, 0.018, 0.03];
          const wx = ((u - b.x) / b.w) * 6, wy = (v - (1 - b.h)) * 90;
          if (wx % 1 > 0.3 && wx % 1 < 0.75 && wy % 1 > 0.35 && win(u * 3 + b.seed, v * 3) > 0.45) c = [1.0, 0.7, 0.32].map(x => x * (0.4 + win(u * 7, v * 7) * 0.8));
        }
      }
      const street = smooth(0.94, 1, v);
      return mix(c, [0.9, 0.5, 0.2], street * 0.5);
    };
  })(),
  'portrait-study': (() => {
    const bg = fbm(41, 4, 3), skin = fbm(42, 5, 12), hair = fbm(43, 6, 20);
    return (u, v) => {
      const x = (u - 0.5) * 1.5, y = v - 0.45;
      let c = mix([0.12, 0.16, 0.18], [0.3, 0.33, 0.3], bg(u, v));
      const face = Math.hypot(x / 0.17, y / 0.25);
      const hairM = Math.hypot(x / 0.21, (y + 0.06) / 0.29) < 1 && !(face < 1 && y > -0.12);
      if (hairM) c = [0.05, 0.03, 0.02].map(k => k * (0.6 + hair(u, v * 3)));
      if (face < 1) {
        const shade = 0.55 + 0.5 * clamp(1 - Math.hypot(x + 0.06, y + 0.05) * 3);
        c = [0.62, 0.38, 0.27].map(k => k * shade * (0.92 + skin(u, v) * 0.16));
        for (const ex of [-0.07, 0.07]) if (Math.hypot((x - ex) / 0.03, (y + 0.03) / 0.012) < 1) c = [0.04, 0.03, 0.03];
        if (Math.hypot(x / 0.05, (y - 0.12) / 0.012) < 1) c = [0.45, 0.12, 0.12];
      }
      const body = v > 0.72 && Math.abs(x) < 0.35 + (v - 0.72);
      if (body) c = [0.25, 0.07, 0.06].map(k => k * (0.7 + bg(u * 4, v * 4) * 0.5));
      return c;
    };
  })(),
  'alpine-lake': (() => {
    const ridge = [makeNoise(51, 8), makeNoise(52, 12), makeNoise(53, 16)], rock = fbm(54, 6, 10), water = fbm(55, 4, 40);
    return (u, v) => {
      const sky = mix([0.18, 0.38, 0.78], [0.72, 0.82, 0.95], v / 0.5);
      const layers = [[0.22, 0.55, 0.62, 0.75], [0.36, 0.38, 0.42, 0.5], [0.48, 0.2, 0.24, 0.26]];
      const reflectV = v > 0.66 ? 0.66 - (v - 0.66) : v;
      let c = sky;
      layers.forEach(([base, r, g, b], i) => {
        const top = base - ridge[i](u, 0.5) * 0.18;
        if (reflectV > top) {
          const snow = i === 0 && reflectV < top + 0.06 ? 0.8 : 0;
          c = mix([r, g, b].map(k => k * (0.6 + rock(u, reflectV) * 0.6)), [0.95, 0.96, 0.98], snow);
        }
      });
      if (v > 0.66) c = c.map((k, i) => k * 0.62 + [0.0, 0.05, 0.08][i] + (water(u, v) - 0.5) * 0.06);
      return c;
    };
  })(),
  'teal-orange-reference': (() => {
    const tex = fbm(61, 5, 6);
    return (u, v) => {
      const t = tex(u, v);
      const lum = clamp(0.08 + 0.75 * Math.pow(1 - Math.abs(u - 0.4) * 1.1, 1.4) * (0.6 + t * 0.6));
      const shadow = [0.02, 0.16, 0.2], highlight = [1.0, 0.62, 0.32];
      const c = mix(shadow, highlight, smooth(0.08, 0.7, lum));
      return c.map(k => k * (0.35 + lum));
    };
  })(),
};

const exifs = {
  'golden-coast': { make: 'Lumora', model: 'Demo Camera', lens: '24-70mm f/2.8', f: 8, shutter: '1/250', iso: 100, focal: 35, date: '2026:06:21 20:41:07' },
  'forest-trail': { make: 'Lumora', model: 'Demo Camera', lens: '24-70mm f/2.8', f: 4, shutter: '1/60', iso: 800, focal: 28, date: '2026:05:02 09:12:44' },
  'city-dusk': { make: 'Lumora', model: 'Demo Camera', lens: '35mm f/1.4', f: 2, shutter: '1/30', iso: 3200, focal: 35, date: '2026:01:14 17:55:30' },
  'portrait-study': { make: 'Lumora', model: 'Demo Camera', lens: '85mm f/1.8', f: 1.8, shutter: '1/200', iso: 200, focal: 85, date: '2026:03:09 14:20:03' },
  'alpine-lake': { make: 'Lumora', model: 'Demo Camera', lens: '16-35mm f/4', f: 11, shutter: '1/125', iso: 64, focal: 18, date: '2025:09:28 11:03:59' },
  'teal-orange-reference': { make: 'Lumora', model: 'Demo Camera', lens: '50mm f/1.8', f: 2.8, shutter: '1/160', iso: 400, focal: 50, date: '2026:07:30 19:27:15' },
};

fs.mkdirSync(OUT, { recursive: true });
for (const [name, fn] of Object.entries(scenes)) await render(name, fn, exifs[name]);
