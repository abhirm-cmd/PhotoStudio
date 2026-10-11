/**
 * GLSL ES 3.0 shaders for the PhotoStudio render pipeline.
 *
 * Pipeline (all intermediate textures are RGBA16F, scene-linear Rec.2020 until the
 * tone stage, display-referred linear Rec.2020 afterward):
 *
 *   decode → [resample] → geometry (orientation, lens, perspective, crop)
 *     → noise reduction → local-contrast pyramids → masks
 *     → develop (WB, exposure, tone, curves, HSL, grading, effects)
 *     → sharpen → view/encode
 */

export const VERT = /* glsl */ `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const HEADER = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;
in vec2 vUv;
out vec4 outColor;
uniform vec4 uRegion; // output-uv rectangle this pass covers (tiles / viewport renders)
vec2 gUv() { return uRegion.xy + vUv * uRegion.zw; }
`;

/** Shared color helpers. Working space: linear Rec.2020. */
export const COLOR_LIB = /* glsl */ `
const vec3 LUMA = vec3(0.2627, 0.6780, 0.0593);
float luma(vec3 c) { return dot(c, LUMA); }
const mat3 REC2020_TO_SRGB = mat3(
  1.6604910, -0.1245505, -0.0181508,
 -0.5876411,  1.1328999, -0.1005789,
 -0.0728499, -0.0083494,  1.1187297);
const mat3 SRGB_TO_REC2020 = mat3(
  0.6274039, 0.0690973, 0.0163914,
  0.3292830, 0.9195404, 0.0880133,
  0.0433131, 0.0113623, 0.8955953);
float cbrt(float x) { return sign(x) * pow(abs(x), 1.0 / 3.0); }
vec3 linSrgbToOklab(vec3 c) {
  float l = cbrt(0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b);
  float m = cbrt(0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b);
  float s = cbrt(0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b);
  return vec3(0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
              1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
              0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s);
}
vec3 oklabToLinSrgb(vec3 c) {
  float l = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
  float m = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
  float s = c.x - 0.0894841775 * c.y - 1.2914855480 * c.z;
  l = l * l * l; m = m * m * m; s = s * s * s;
  return vec3(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
             -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
             -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
}
vec3 toLab(vec3 rec2020) { return linSrgbToOklab(REC2020_TO_SRGB * rec2020); }
vec3 fromLab(vec3 lab) { return SRGB_TO_REC2020 * oklabToLinSrgb(lab); }
float srgbEncode(float v) { return v <= 0.0031308 ? v * 12.92 : 1.055 * pow(max(v, 0.0), 1.0 / 2.4) - 0.055; }
float srgbDecode(float v) { return v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4); }
vec3 srgbEncode3(vec3 c) { return vec3(srgbEncode(c.r), srgbEncode(c.g), srgbEncode(c.b)); }
vec3 srgbDecode3(vec3 c) { return vec3(srgbDecode(c.r), srgbDecode(c.g), srgbDecode(c.b)); }
// Perceptual encoding used for tone/curve operations (pure gamma 2.2, invertible for negatives).
vec3 percEncode(vec3 c) { return sign(c) * pow(abs(c), vec3(1.0 / 2.2)); }
vec3 percDecode(vec3 c) { return sign(c) * pow(abs(c), vec3(2.2)); }
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
`;

/** Geometry mapping shared by the geometry pass and mask components. */
export const GEOMETRY_LIB = /* glsl */ `
uniform vec2 uSrcSize;    // base texture size (px)
uniform vec2 uFrameSize;  // oriented frame size (px)
uniform vec4 uCrop;       // x,y,w,h in frame-normalized coords
uniform float uAngle;     // straighten (radians)
uniform mat3 uHomInv;     // inverse perspective (normalized centered coords)
uniform vec4 uLens;       // ptlens a,b,c,d (normalized to half diagonal)
uniform mat2 uOrient;     // oriented-centered → source-centered
float halfDiag() { return 0.5 * length(uFrameSize); }
// Output uv (0..1 over crop) → oriented normalized coordinates before lens distortion.
vec2 outToIdeal(vec2 uv) {
  vec2 f = (uCrop.xy + uv * uCrop.zw) * uFrameSize;
  vec2 c = f - 0.5 * uFrameSize;
  float ca = cos(uAngle), sa = sin(uAngle);
  c = vec2(ca * c.x - sa * c.y, sa * c.x + ca * c.y);
  vec2 n = c / halfDiag();
  vec3 h = uHomInv * vec3(n, 1.0);
  return h.xy / h.z;
}
vec2 idealToSrc(vec2 n, float chanScale) {
  // PTLens radial model: r_d = r (a r^3 + b r^2 + c r + d); identity is (0,0,0,1).
  float r = length(n);
  float rd = r * (uLens.x * r * r * r + uLens.y * r * r + uLens.z * r + uLens.w);
  n = r > 1e-6 ? n * (rd / r) : n;
  n *= chanScale;
  vec2 s = uOrient * (n * halfDiag());
  return (s + 0.5 * uSrcSize) / uSrcSize;
}
vec2 outToSrc(vec2 uv) { return idealToSrc(outToIdeal(uv), 1.0); }
`;

/* ------------------------------------------------------------------ decode */

export const DECODE_UINT16 = HEADER + /* glsl */ `
uniform highp usampler2D uSrc;
uniform mat3 uInput;   // source primaries → Rec.2020
uniform float uScale;  // 1/65535 * gain
uniform int uTransfer; // 0 linear, 1 sRGB
${COLOR_LIB}
void main() {
  // Row 0 of every pipeline texture is the top of the image (uv y-down convention).
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 c = vec3(texelFetch(uSrc, p, 0).rgb) * uScale;
  if (uTransfer == 1) c = srgbDecode3(c);
  outColor = vec4(uInput * c, 1.0);
}`;

export const DECODE_RGBA8 = HEADER + /* glsl */ `
uniform sampler2D uSrc; // SRGB8_ALPHA8 → already linear when sampled
uniform mat3 uInput;
${COLOR_LIB}
void main() {
  vec4 c = texture(uSrc, vUv);
  outColor = vec4(uInput * c.rgb, 1.0);
}`;

/** Area-averaging downsample (used for previews and pyramids). */
export const RESAMPLE = HEADER + /* glsl */ `
uniform sampler2D uSrc;
uniform vec2 uTexel;   // 1/src size
uniform vec2 uRatio;   // src px per dst px
void main() {
  vec3 acc = vec3(0.0); float a = 0.0; float n = 0.0;
  vec2 taps = clamp(ceil(uRatio), vec2(1.0), vec2(6.0));
  for (float y = 0.0; y < 6.0; y++) {
    if (y >= taps.y) break;
    for (float x = 0.0; x < 6.0; x++) {
      if (x >= taps.x) break;
      vec2 o = ((vec2(x, y) + 0.5) / taps - 0.5) * uRatio * uTexel;
      vec4 s = texture(uSrc, vUv + o);
      acc += s.rgb; a += s.a; n += 1.0;
    }
  }
  outColor = vec4(acc / n, a / n);
}`;

/* ---------------------------------------------------------------- geometry */

export const GEOMETRY = HEADER + /* glsl */ `
uniform sampler2D uSrc;
uniform vec2 uCA;        // lateral CA scale for red/blue
uniform vec4 uVig;       // lens vignetting k1,k2,k3 ; w = manual amount
uniform float uVigMid;
${GEOMETRY_LIB}
bool inside(vec2 p) { return all(greaterThanEqual(p, vec2(0.0))) && all(lessThanEqual(p, vec2(1.0))); }
void main() {
  vec2 n = outToIdeal(gUv());
  vec2 sg = idealToSrc(n, 1.0);
  if (!inside(sg)) { outColor = vec4(0.0); return; }
  vec3 c;
  c.g = texture(uSrc, sg).g;
  c.r = texture(uSrc, idealToSrc(n, uCA.x)).r;
  c.b = texture(uSrc, idealToSrc(n, uCA.y)).b;
  // Lens vignetting correction (radius normalized to half diagonal)
  float r = length(n);
  float r2 = r * r;
  float v = 1.0 + uVig.x * r2 + uVig.y * r2 * r2 + uVig.z * r2 * r2 * r2;
  c /= max(v, 0.05);
  // Manual vignetting correction: positive brightens corners
  float t = smoothstep(uVigMid * 0.9, 1.05, r);
  c *= exp2(uVig.w * 1.5 * t * t);
  outColor = vec4(c, 1.0);
}`;

/* ---------------------------------------------------------- noise reduction */

/** Applies the summed local value of one mask parameter (index uParam) — used by NR/sharpen. */
export const MASK_PARAM_LIB = /* glsl */ `
#define MAX_MASKS 12
uniform sampler2DArray uMasks;
uniform int uMaskCount;
uniform float uMaskDensity[MAX_MASKS];
uniform float uMaskParam[MAX_MASKS];
float localParam(vec2 uv) {
  float s = 0.0;
  for (int i = 0; i < MAX_MASKS; i++) {
    if (i >= uMaskCount) break;
    if (uMaskParam[i] == 0.0) continue;
    s += texture(uMasks, vec3(uv, float(i))).r * uMaskDensity[i] * uMaskParam[i];
  }
  return s;
}`;

export const DENOISE = HEADER + /* glsl */ `
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uLuma;    // 0..1
uniform float uDetail;  // 0..1 (higher = keep more detail)
uniform float uChroma;  // 0..1
uniform float uPxScale; // preview px → full-res px ratio (<=1)
${COLOR_LIB}
${MASK_PARAM_LIB}
void main() {
  vec4 c0 = texture(uSrc, vUv);
  if (c0.a == 0.0) { outColor = c0; return; }
  float lumaAmt = clamp(uLuma + localParam(gUv()) / 100.0, 0.0, 1.0);
  if (lumaAmt <= 0.0 && uChroma <= 0.0) { outColor = c0; return; }
  float y0 = log2(max(luma(c0.rgb), 1e-5));
  vec3 lab0 = toLab(c0.rgb);
  float sigR = mix(0.12, 0.6, lumaAmt) * mix(1.0, 0.35, uDetail);
  float stepL = max(1.0, 1.5 * uPxScale + 0.5);
  float stepC = max(1.5, 3.0 * uPxScale + 1.0);
  float wsum = 0.0; float ysum = 0.0;
  vec2 csum = vec2(0.0); float cw = 0.0;
  for (int j = -3; j <= 3; j++) {
    for (int i = -3; i <= 3; i++) {
      vec2 o = vec2(float(i), float(j));
      float sp = exp(-dot(o, o) / 8.0);
      vec3 s = texture(uSrc, vUv + o * uTexel * stepL).rgb;
      float ys = log2(max(luma(s), 1e-5));
      float w = sp * exp(-pow(ys - y0, 2.0) / (2.0 * sigR * sigR));
      ysum += ys * w; wsum += w;
      vec3 sc = texture(uSrc, vUv + o * uTexel * stepC).rgb;
      vec3 labS = toLab(sc);
      float wc = sp * exp(-pow(labS.x - lab0.x, 2.0) / 0.004);
      csum += labS.yz * wc; cw += wc;
    }
  }
  float yNr = mix(y0, ysum / wsum, lumaAmt);
  vec3 c = c0.rgb * exp2(yNr - y0);
  vec3 lab = toLab(c);
  lab.yz = mix(lab.yz, csum / cw, uChroma);
  outColor = vec4(fromLab(lab), 1.0);
}`;

/* ----------------------------------------------------- luminance pyramids */

/** Extracts log-luminance (r) and dark channel (g) for local-contrast & dehaze. */
export const LUMA_EXTRACT = HEADER + /* glsl */ `
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform vec2 uRatio;
${COLOR_LIB}
void main() {
  vec2 taps = clamp(ceil(uRatio), vec2(1.0), vec2(6.0));
  float l = 0.0; float d = 0.0; float n = 0.0;
  for (float y = 0.0; y < 6.0; y++) {
    if (y >= taps.y) break;
    for (float x = 0.0; x < 6.0; x++) {
      if (x >= taps.x) break;
      vec2 o = ((vec2(x, y) + 0.5) / taps - 0.5) * uRatio * uTexel;
      vec4 s = texture(uSrc, vUv + o);
      l += log2(max(luma(s.rgb), 1e-5)); d += min(min(s.r, s.g), s.b); n += 1.0;
    }
  }
  outColor = vec4(l / n, d / n, 0.0, 1.0);
}`;

export const BLUR = HEADER + /* glsl */ `
uniform sampler2D uSrc;
uniform vec2 uDir;     // texel step * direction
uniform float uSigma;  // in texels
void main() {
  float s = max(uSigma, 0.5);
  int r = int(min(ceil(s * 3.0), 32.0));
  vec4 acc = texture(uSrc, vUv); float wsum = 1.0;
  for (int i = 1; i <= 32; i++) {
    if (i > r) break;
    float w = exp(-float(i * i) / (2.0 * s * s));
    acc += (texture(uSrc, vUv + uDir * float(i)) + texture(uSrc, vUv - uDir * float(i))) * w;
    wsum += 2.0 * w;
  }
  outColor = acc / wsum;
}`;

/* -------------------------------------------------------------------- masks */

export const MASK_COMPONENT = HEADER + /* glsl */ `
uniform int uType;        // 0 all, 1 linear, 2 radial, 3 texture (brush/ai), 4 color, 5 luminance
uniform bool uInvert;
uniform int uOp;          // 0 add, 1 subtract, 2 intersect
uniform vec4 uA;          // linear: a.xy b.xy (src normalized) ; radial: cx,cy,rx,ry
uniform vec4 uB;          // radial: angle, feather ; luminance: min,max,feather
uniform sampler2D uTex;   // brush/ai bitmap in source space
uniform sampler2D uImage; // geometry output (for color / luminance)
uniform vec3 uSamples[8]; // OkLab samples
uniform int uSampleCount;
uniform float uRange;
${COLOR_LIB}
${GEOMETRY_LIB}
float component() {
  if (uType == 0) return 1.0;
  if (uType == 4 || uType == 5) {
    vec3 c = texture(uImage, vUv).rgb;
    vec3 lab = toLab(c / (1.0 + c)); // soft tonemap for robust comparisons
    if (uType == 5) {
      float L = clamp(pow(max(luma(c), 0.0) / (1.0 + luma(c)), 1.0 / 2.2) * 1.3, 0.0, 1.0);
      float f = max(uB.z, 0.001);
      return smoothstep(uB.x - f, uB.x + f * 0.25, L) * (1.0 - smoothstep(uB.y - f * 0.25, uB.y + f, L));
    }
    float best = 1e3;
    for (int i = 0; i < 8; i++) {
      if (i >= uSampleCount) break;
      vec3 d = lab - uSamples[i];
      float dist = length(vec3(d.x * 0.6, d.yz * 1.6));
      best = min(best, dist);
    }
    float r = mix(0.03, 0.28, uRange);
    return 1.0 - smoothstep(r * 0.6, r, best);
  }
  vec2 sp = outToSrc(gUv());
  if (uType == 3) {
    if (any(lessThan(sp, vec2(0.0))) || any(greaterThan(sp, vec2(1.0)))) return 0.0;
    return texture(uTex, vec2(sp.x, sp.y)).r;
  }
  vec2 px = sp * uSrcSize;
  if (uType == 1) {
    vec2 a = uA.xy * uSrcSize, b = uA.zw * uSrcSize;
    vec2 ab = b - a;
    float t = dot(px - a, ab) / max(dot(ab, ab), 1e-6);
    return 1.0 - smoothstep(0.0, 1.0, t);
  }
  if (uType == 2) {
    vec2 c = uA.xy * uSrcSize;
    vec2 d = px - c;
    float ca = cos(-uB.x), sa = sin(-uB.x);
    d = vec2(ca * d.x - sa * d.y, sa * d.x + ca * d.y);
    vec2 r = max(uA.zw * uSrcSize, vec2(1.0));
    float e = length(d / r);
    float f = clamp(uB.y, 0.0, 1.0);
    return 1.0 - smoothstep(1.0 - f, 1.0, e);
  }
  return 0.0;
}
void main() {
  float v = component();
  if (uInvert) v = 1.0 - v;
  // Ops are realized with blend equations: add=MAX(v), intersect=MIN(v), subtract=MIN(1-v)
  if (uOp == 1) v = 1.0 - v;
  outColor = vec4(v, v, v, 1.0);
}`;

/** Brush dabs rasterized as instanced quads into a source-space bitmap. */
export const BRUSH_VERT = /* glsl */ `#version 300 es
in vec2 aPos;
in vec4 aDab;    // x, y (normalized src), radius (normalized to long edge), flow
in float aFeather;
uniform vec2 uAspect; // long-edge normalized → per-axis scale
out vec2 vLocal;
out float vFlow;
out float vFeather;
void main() {
  vLocal = aPos;
  vFlow = aDab.w;
  vFeather = aFeather;
  vec2 p = aDab.xy + aPos * aDab.z * uAspect;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export const BRUSH_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
in float vFlow;
in float vFeather;
out vec4 outColor;
void main() {
  float d = length(vLocal);
  if (d > 1.0) discard;
  float f = clamp(vFeather, 0.0, 1.0);
  float a = (1.0 - smoothstep(1.0 - f, 1.0, d)) * vFlow;
  outColor = vec4(a, a, a, a);
}`;

/** Mask finalize: feather (blur already applied), edge-aware refine, invert. */
export const MASK_REFINE = HEADER + /* glsl */ `
uniform sampler2D uMask;
uniform sampler2D uImage;
uniform vec2 uTexel;
uniform float uRefine;  // 0..1
uniform bool uInvert;
${COLOR_LIB}
void main() {
  float m0 = texture(uMask, vUv).r;
  float m = m0;
  if (uRefine > 0.0) {
    float l0 = log2(max(luma(texture(uImage, vUv).rgb), 1e-4));
    float acc = 0.0, ws = 0.0;
    float stepPx = 1.0 + uRefine * 3.0;
    for (int j = -4; j <= 4; j++) for (int i = -4; i <= 4; i++) {
      vec2 o = vec2(float(i), float(j)) * stepPx * uTexel;
      float l = log2(max(luma(texture(uImage, vUv + o).rgb), 1e-4));
      float w = exp(-float(i * i + j * j) / 18.0) * exp(-pow(l - l0, 2.0) / (2.0 * 0.08));
      acc += texture(uMask, vUv + o).r * w; ws += w;
    }
    float refined = acc / ws;
    // Snap toward edges: sharpen the transition around 0.5
    refined = smoothstep(0.5 - 0.5 * (1.0 - uRefine * 0.7), 0.5 + 0.5 * (1.0 - uRefine * 0.7), refined);
    m = mix(m0, refined, uRefine);
  }
  if (uInvert) m = 1.0 - m;
  outColor = vec4(m, m, m, 1.0);
}`;

/* ------------------------------------------------------------------ develop */

/**
 * Local adjustment slots (per mask), packed in 5 vec4:
 *  0: exposure, contrast, highlights, shadows
 *  1: whites, blacks, temp, tint
 *  2: saturation, vibrance, texture, clarity
 *  3: dehaze, sharpness, noise, hue
 *  4: colorHue, colorSat, -, -
 */
export const DEVELOP = HEADER + /* glsl */ `
uniform sampler2D uSrc;      // denoised geometry output (scene linear)
uniform sampler2D uFine;     // fine blur: r = log luma
uniform sampler2D uMid;      // mid blur:  r = log luma
uniform sampler2D uLarge;    // large blur: r = log luma, g = dark channel
uniform sampler2D uCurve;    // 1024x1 LUT, per-channel
uniform vec2 uOutSize;       // full output px (whole crop) at this render's scale
uniform float uPxScale;      // output px → full-res px

uniform mat3 uWB;            // white balance (working space)
uniform mat3 uCalib;         // calibration primaries
uniform float uShadowTint;
uniform int uProfile;        // 0 display-referred, 1 tone-mapped, 4 linear
uniform bool uMono;
uniform float uBaseline;     // profile baseline exposure (EV)
uniform vec3 uProfileParams; // white point W, base contrast, base saturation

uniform float uExposure;
uniform float uContrast, uHighlights, uShadows, uWhites, uBlacks;
uniform float uTexture, uClarity, uDehaze;
uniform float uVibrance, uSaturation;
uniform vec3 uAtmos;         // dehaze atmospheric light

uniform vec3 uHsl[8];        // hue, sat, lum per channel (-1..1)
uniform float uHslCenters[8];

uniform vec4 uGradeShadows;  // a, b offset (OkLab), lum, -
uniform vec4 uGradeMid;
uniform vec4 uGradeHigh;
uniform vec4 uGradeGlobal;
uniform float uGradeBlend;   // 0..1
uniform float uGradeBalance; // -1..1

uniform vec4 uVignette;      // amount, midpoint, roundness, feather
uniform float uVignetteHL;
uniform vec3 uGrain;         // amount, size, roughness
uniform float uGrainSeed;

uniform vec4 uPortrait;      // skinSmoothing(not here), skinTone, skinEvenness, faceLight
uniform vec2 uPortrait2;     // eyes, teeth
uniform float uDefringe[2];  // purple, green

#define MAX_MASKS 12
uniform sampler2DArray uMasks;
uniform int uMaskCount;
uniform float uMaskDensity[MAX_MASKS];
uniform vec4 uLocal[MAX_MASKS * 5];
uniform int uPortraitMask;   // mask index for skin (-1 none)
uniform int uEyeMask;
uniform int uTeethMask;

${COLOR_LIB}

// Profile base tone map: scene-linear → display-linear. Extended Reinhard with
// white point W so sensor saturation (after baseline exposure) lands exactly on 1.0.
vec3 baseCurve(vec3 c) {
  if (uProfile == 0) return c;                       // already display-referred
  if (uProfile == 4) return c;                       // linear: no tone mapping
  float W = uProfileParams.x;
  vec3 xs = max(c, 0.0);
  vec3 perChan = xs * (1.0 + xs / (W * W)) / (1.0 + xs);
  // Hue-preserving variant (avoids skewing saturated highlights), blended for a natural look.
  float m = max(max(xs.r, xs.g), xs.b);
  float mt = m * (1.0 + m / (W * W)) / (1.0 + m);
  vec3 ratio = m > 1e-6 ? xs * (mt / m) : vec3(0.0);
  return mix(perChan, ratio, 0.55);
}

float invSmoothstep(float t) { return 0.5 - sin(asin(clamp(1.0 - 2.0 * t, -1.0, 1.0)) / 3.0); }
float applyContrast(float p, float k) {
  float t = clamp(p, 0.0, 1.0);
  float s = k >= 0.0 ? mix(t, t * t * (3.0 - 2.0 * t), min(k, 1.0)) : mix(t, invSmoothstep(t), min(-k, 1.0));
  if (k > 1.0) s = mix(s, s * s * (3.0 - 2.0 * s), k - 1.0);
  return s + (p - t);
}

float hueDist(float a, float b) { float d = abs(a - b); return min(d, 360.0 - d); }

// Piecewise-linear interpolation weights between adjacent channel centers (sum to 1).
void hslWeights(float h, out float w[8]) {
  for (int i = 0; i < 8; i++) w[i] = 0.0;
  for (int i = 0; i < 8; i++) {
    int j = (i + 1) % 8;
    float a = uHslCenters[i];
    float b = uHslCenters[j];
    float span = mod(b - a + 360.0, 360.0);
    float d = mod(h - a + 360.0, 360.0);
    if (d <= span) {
      float t = d / span;
      t = t * t * (3.0 - 2.0 * t);
      w[i] = 1.0 - t; w[j] = t;
      return;
    }
  }
}

float skinWeight(vec3 lab) {
  float C = length(lab.yz);
  float h = degrees(atan(lab.z, lab.y));
  if (h < 0.0) h += 360.0;
  float hw = 1.0 - smoothstep(12.0, 30.0, hueDist(h, 55.0));
  float cw = smoothstep(0.02, 0.05, C) * (1.0 - smoothstep(0.16, 0.24, C));
  float lw = smoothstep(0.3, 0.45, lab.x) * (1.0 - smoothstep(0.9, 0.98, lab.x));
  return hw * cw * lw;
}

void main() {
  vec4 src = texture(uSrc, vUv);
  if (src.a == 0.0) { outColor = vec4(0.0); return; }
  vec3 c = src.rgb;
  vec2 G = gUv();

  // ---- gather local adjustments
  vec4 L0 = vec4(0.0), L1 = vec4(0.0), L2 = vec4(0.0), L3 = vec4(0.0), L4 = vec4(0.0);
  float colorW = 0.0;
  for (int i = 0; i < MAX_MASKS; i++) {
    if (i >= uMaskCount) break;
    float m = texture(uMasks, vec3(G, float(i))).r * uMaskDensity[i];
    if (m <= 0.0) continue;
    L0 += uLocal[i * 5 + 0] * m;
    L1 += uLocal[i * 5 + 1] * m;
    L2 += uLocal[i * 5 + 2] * m;
    L3 += uLocal[i * 5 + 3] * m;
    vec4 l4 = uLocal[i * 5 + 4];
    if (l4.y > 0.0) { L4.xy += vec2(cos(radians(l4.x)), sin(radians(l4.x))) * (l4.y / 100.0) * m; colorW += m; }
  }

  // ---- white balance (+ local temp/tint) and highlight reconstruction
  float clipSrc = smoothstep(0.92, 1.0, max(max(c.r, c.g), c.b));
  c = uWB * c;
  if (L1.z != 0.0 || L1.w != 0.0) {
    float t = L1.z / 100.0, ti = L1.w / 100.0;
    c *= vec3(exp2(t * 0.45), exp2(-ti * 0.35), exp2(-t * 0.6));
  }
  c = mix(c, vec3(max(max(c.r, c.g), c.b)), clipSrc * 0.85);

  // ---- calibration
  c = uCalib * c;
  float ys0 = luma(c);
  if (uShadowTint != 0.0) {
    float sw = 1.0 - smoothstep(0.0, 0.25, ys0);
    c *= mix(vec3(1.0), vec3(1.0 + uShadowTint * 0.15, 1.0 - uShadowTint * 0.2, 1.0 + uShadowTint * 0.15), sw);
  }

  // ---- exposure
  c *= exp2(uExposure + uBaseline + L0.x);

  // ---- dehaze (dark channel prior, approximated with a blurred dark channel)
  float dh = clamp(uDehaze + L3.x / 100.0, -1.0, 1.0);
  if (dh != 0.0) {
    float dark = texture(uLarge, G).g * exp2(uExposure + uBaseline + L0.x);
    vec3 A = uAtmos * exp2(uExposure + uBaseline);
    float Am = max(max(A.r, A.g), max(A.b, 1e-3));
    if (dh > 0.0) {
      float t = max(1.0 - dh * 0.92 * clamp(dark / Am, 0.0, 1.0), 0.12);
      c = (c - A * (1.0 - t)) / t;
      c = max(c, vec3(0.0));
    } else {
      c = mix(c, A * 0.9, -dh * 0.45);
    }
  }

  // ---- local contrast & shadows/highlights in log-luminance
  float Y = max(luma(c), 1e-6);
  float lg = log2(Y);
  float expShift = uExposure + uBaseline + L0.x;
  float fine = texture(uFine, vUv).r + expShift;
  float mid = texture(uMid, G).r + expShift;
  float large = texture(uLarge, G).r + expShift;
  float tex = clamp(uTexture + L2.z / 100.0, -1.0, 1.0);
  float cla = clamp(uClarity + L2.w / 100.0, -1.0, 1.0);
  float lgN = lg;
  lgN += tex * 0.9 * clamp(lg - fine, -2.0, 2.0);
  float midW = exp(-pow((lg + 2.5) / 3.0, 2.0));
  lgN += cla * 0.75 * midW * clamp(lg - mid, -3.0, 3.0);
  float base = mix(lg, large, 0.75);
  float sh = clamp(uShadows + L0.w / 100.0, -1.0, 1.0);
  float hl = clamp(uHighlights + L0.z / 100.0, -1.0, 1.0);
  float shW = 1.0 - smoothstep(-7.0, -1.5, base);
  float hlW = smoothstep(-2.8, 0.5, base);
  lgN += sh * 1.6 * shW;
  lgN += hl * 1.35 * hlW;
  c *= exp2(lgN - lg);

  // ---- profile base curve → perceptual space
  vec3 disp = baseCurve(c);
  vec3 p = percEncode(disp);

  // ---- whites / blacks / contrast
  float wh = clamp(uWhites + L1.x / 100.0, -1.0, 1.0);
  float bl = clamp(uBlacks + L1.y / 100.0, -1.0, 1.0);
  float con = clamp(uContrast + uProfileParams.y + L0.y / 100.0, -1.0, 1.2);
  vec3 pw = p * (1.0 + wh * 0.28);
  p = mix(p, pw, smoothstep(0.2, 1.0, p));
  p = p + bl * 0.16 * pow(clamp(1.0 - p, 0.0, 1.0), vec3(4.0));
  p = vec3(applyContrast(p.r, con * 0.9), applyContrast(p.g, con * 0.9), applyContrast(p.b, con * 0.9));

  // ---- tone curve LUT (per channel, includes master + parametric)
  vec3 pc = clamp(p, 0.0, 1.0);
  vec3 over = p - pc;
  pc = vec3(texture(uCurve, vec2(pc.r * (1023.0 / 1024.0) + 0.5 / 1024.0, 0.5)).r,
            texture(uCurve, vec2(pc.g * (1023.0 / 1024.0) + 0.5 / 1024.0, 0.5)).g,
            texture(uCurve, vec2(pc.b * (1023.0 / 1024.0) + 0.5 / 1024.0, 0.5)).b);
  p = pc + over;

  // ---- color in OkLCh
  vec3 lin = percDecode(p);
  vec3 lab = toLab(lin);
  float C = length(lab.yz);
  float h = degrees(atan(lab.z, lab.y));
  if (h < 0.0) h += 360.0;

  // HSL mixer
  float w[8];
  hslWeights(h, w);
  float dh2 = 0.0, ds = 0.0, dl = 0.0;
  for (int i = 0; i < 8; i++) { dh2 += w[i] * uHsl[i].x; ds += w[i] * uHsl[i].y; dl += w[i] * uHsl[i].z; }
  float chromaW = smoothstep(0.0, 0.05, C);
  h += dh2 * 30.0 * chromaW;
  C *= max(0.0, 1.0 + ds);
  lab.x += dl * 0.16 * chromaW * (1.0 - abs(lab.x - 0.5));

  // Calibrated portrait tools on skin mask
  if (uPortraitMask >= 0) {
    float sm = texture(uMasks, vec3(G, float(uPortraitMask))).r;
    float sk = sm * skinWeight(vec3(lab.x, C * cos(radians(h)), C * sin(radians(h))));
    // skin tone warmth: shift hue a few degrees toward orange/pink
    h += uPortrait.y * 6.0 * sk;
    // evenness: pull chroma/hue toward typical skin
    C = mix(C, mix(C, 0.085, 0.6), uPortrait.z * sk);
    h = mix(h, mix(h, 58.0, 0.5), uPortrait.z * sk * 0.6);
    lab.x += uPortrait.w * 0.06 * sm;
  }
  if (uEyeMask >= 0) {
    float em = texture(uMasks, vec3(G, float(uEyeMask))).r;
    lab.x += uPortrait2.x * 0.05 * em; C *= 1.0 + uPortrait2.x * 0.25 * em;
  }
  if (uTeethMask >= 0) {
    float tm = texture(uMasks, vec3(G, float(uTeethMask))).r;
    C *= 1.0 - uPortrait2.y * 0.65 * tm; lab.x += uPortrait2.y * 0.04 * tm;
  }

  // Defringe: desaturate purple/green fringes near high-contrast edges
  if (uDefringe[0] > 0.0 || uDefringe[1] > 0.0) {
    float edge = clamp(abs(lg - fine) * 1.5, 0.0, 1.0);
    float purpleW = 1.0 - smoothstep(15.0, 40.0, hueDist(h, 315.0));
    float greenW = 1.0 - smoothstep(15.0, 40.0, hueDist(h, 135.0));
    C *= 1.0 - edge * (purpleW * uDefringe[0] + greenW * uDefringe[1]);
  }

  // Local hue rotation
  h += L3.w * chromaW;

  // Vibrance (protects skin) & saturation
  float vib = clamp(uVibrance + L2.y / 100.0, -1.0, 1.0);
  float sat = clamp(uSaturation + L2.x / 100.0, -1.0, 1.0);
  float skinProtect = 1.0 - 0.6 * (1.0 - smoothstep(10.0, 35.0, hueDist(h, 55.0)));
  if (vib > 0.0) C *= 1.0 + vib * 0.9 * (1.0 - smoothstep(0.0, 0.18, C)) * skinProtect;
  else C *= 1.0 + vib * 0.8;
  C *= max(0.0, 1.0 + sat) * (1.0 + uProfileParams.z);

  lab.yz = C * vec2(cos(radians(h)), sin(radians(h)));

  // Color grading (3-way + global) — offsets in OkLab ab
  float Lx = clamp(lab.x, 0.0, 1.0);
  float pivot = 0.5 + uGradeBalance * 0.25;
  float width = mix(0.08, 0.45, uGradeBlend);
  float ws = 1.0 - smoothstep(pivot - width, pivot + width * 0.25, Lx);
  float whi = smoothstep(pivot - width * 0.25, pivot + width, Lx);
  float wm = clamp(1.0 - ws - whi, 0.0, 1.0) + 0.0;
  wm = max(wm, 0.0) * (1.0 - 0.5 * abs(Lx - pivot));
  lab.yz += uGradeShadows.xy * ws + uGradeMid.xy * wm + uGradeHigh.xy * whi + uGradeGlobal.xy;
  lab.x += uGradeShadows.z * ws + uGradeMid.z * wm + uGradeHigh.z * whi + uGradeGlobal.z;

  // Local color overlay
  if (colorW > 0.0) lab.yz = mix(lab.yz, L4.xy * 0.12 / max(colorW, 1e-3), clamp(length(L4.xy) * 0.6, 0.0, 0.8));

  lin = fromLab(lab);
  if (uMono) lin = vec3(luma(lin));
  p = percEncode(lin);

  // ---- post-crop vignette
  if (uVignette.x != 0.0) {
    vec2 q = G - 0.5;
    float aspect = uOutSize.x / uOutSize.y;
    float roundK = (uVignette.z + 1.0) * 0.5; // 0 = follow frame, 1 = circle
    vec2 qa = mix(q * 2.0, q * 2.0 * vec2(aspect, 1.0) / max(aspect, 1.0), roundK);
    float r = length(qa) / 1.4142;
    float mid2 = mix(0.15, 0.95, uVignette.y);
    float feather = mix(0.05, 0.9, uVignette.w);
    float f = smoothstep(mid2 - feather * 0.5, mid2 + feather * 0.5, r);
    float amt = uVignette.x;
    float lum = luma(percDecode(p));
    float protect = amt < 0.0 ? 1.0 - uVignetteHL * smoothstep(0.4, 0.95, lum) : 1.0;
    p = amt < 0.0 ? p * (1.0 + amt * 0.85 * f * protect) : mix(p, vec3(1.0), amt * 0.7 * f);
  }

  // ---- grain (resolution independent: coordinates in full-res pixels)
  if (uGrain.x > 0.0) {
    vec2 fp = G * uOutSize / uPxScale;
    float sz = mix(0.8, 4.0, uGrain.y);
    vec2 gp = fp / sz + uGrainSeed;
    vec2 i = floor(gp), f = fract(gp);
    f = f * f * (3.0 - 2.0 * f);
    float n00 = hash12(i), n10 = hash12(i + vec2(1, 0)), n01 = hash12(i + vec2(0, 1)), n11 = hash12(i + vec2(1, 1));
    float n = mix(mix(n00, n10, f.x), mix(n01, n11, f.x), f.y);
    float fineN = hash12(floor(fp / max(sz * 0.5, 0.5)) + 17.0);
    n = mix(n, fineN, uGrain.z * 0.6) - 0.5;
    float l = luma(clamp(p, 0.0, 1.0));
    float amp = uGrain.x * 0.16 * (0.35 + 4.0 * l * (1.0 - l));
    p += n * amp;
  }

  outColor = vec4(percDecode(p), 1.0);
}`;

/* ------------------------------------------------------------------- sharpen */

export const SHARPEN = HEADER + /* glsl */ `
uniform sampler2D uSrc;
uniform sampler2D uBlur;     // blurred luminance (r = perceptual luma)
uniform vec2 uTexel;
uniform float uAmount;       // 0..1.5
uniform float uDetail;       // 0..1
uniform float uMasking;      // 0..1
${COLOR_LIB}
${MASK_PARAM_LIB}
void main() {
  vec4 c = texture(uSrc, vUv);
  if (c.a == 0.0) { outColor = c; return; }
  float amt = max(uAmount + localParam(gUv()) / 100.0, -1.0);
  if (amt == 0.0) { outColor = c; return; }
  float y = pow(max(luma(c.rgb), 0.0), 1.0 / 2.2);
  float yb = texture(uBlur, vUv).r;
  float d = y - yb;
  float lim = mix(0.02, 0.35, uDetail);
  d = clamp(d, -lim, lim);
  if (uMasking > 0.0) {
    float gx = texture(uBlur, vUv + vec2(uTexel.x, 0.0)).r - texture(uBlur, vUv - vec2(uTexel.x, 0.0)).r;
    float gy = texture(uBlur, vUv + vec2(0.0, uTexel.y)).r - texture(uBlur, vUv - vec2(0.0, uTexel.y)).r;
    float g = length(vec2(gx, gy));
    d *= smoothstep(uMasking * 0.04, uMasking * 0.04 + 0.02, g);
  }
  float y2 = max(y + amt * 1.6 * d, 0.0);
  float ratio = y > 1e-4 ? pow(y2, 2.2) / pow(y, 2.2) : 1.0;
  outColor = vec4(c.rgb * ratio, c.a);
}`;

export const PERC_LUMA = HEADER + /* glsl */ `
uniform sampler2D uSrc;
${COLOR_LIB}
void main() { float y = pow(max(luma(texture(uSrc, vUv).rgb), 0.0), 1.0 / 2.2); outColor = vec4(y, y, y, 1.0); }`;

/* ---------------------------------------------------------------------- view */

export const VIEW = HEADER + /* glsl */ `
uniform sampler2D uAfter;
uniform sampler2D uBefore;
uniform sampler2DArray uMasks;
uniform mat3 uViewInv;       // canvas px → image uv
uniform vec2 uCanvas;
uniform int uMode;           // 0 after, 1 before, 2 split-vertical, 3 split-horizontal
uniform float uSplit;        // 0..1 split position in canvas space
uniform bool uClipping;
uniform int uOverlayMask;    // -1 none
uniform vec3 uOverlayColor;
uniform float uOverlayOpacity;
uniform mat3 uOutput;        // Rec.2020 → display primaries
uniform vec3 uBg;
${COLOR_LIB}
void main() {
  vec2 px = vec2(gl_FragCoord.x, uCanvas.y - gl_FragCoord.y);
  vec3 uvw = uViewInv * vec3(px, 1.0);
  vec2 uv = uvw.xy;
  vec3 bg = uBg;
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) { outColor = vec4(bg, 1.0); return; }
  bool useBefore = uMode == 1 || (uMode == 2 && px.x < uSplit * uCanvas.x) || (uMode == 3 && px.y < uSplit * uCanvas.y);
  vec4 s = useBefore ? texture(uBefore, uv) : texture(uAfter, uv);
  if (s.a == 0.0) { outColor = vec4(mix(bg, vec3(0.16), 0.5), 1.0); return; }
  vec3 d = uOutput * s.rgb;
  vec3 e = srgbEncode3(clamp(d, 0.0, 1.0));
  if (uClipping) {
    if (max(max(d.r, d.g), d.b) >= 0.999) e = vec3(1.0, 0.12, 0.12);
    else if (min(min(d.r, d.g), d.b) <= 0.0005 && max(max(d.r, d.g), d.b) <= 0.002) e = vec3(0.12, 0.35, 1.0);
  }
  if (uOverlayMask >= 0 && !useBefore) {
    float m = texture(uMasks, vec3(uv, float(uOverlayMask))).r;
    e = mix(e, uOverlayColor, m * uOverlayOpacity);
  }
  if (uMode >= 2) {
    float edge = uMode == 2 ? abs(px.x - uSplit * uCanvas.x) : abs(px.y - uSplit * uCanvas.y);
    e = mix(vec3(1.0), e, smoothstep(0.5, 1.5, edge));
  }
  outColor = vec4(e, 1.0);
}`;

/** Encodes the final texture into the export color space (8/16-bit readback). */
export const ENCODE = HEADER + /* glsl */ `
uniform sampler2D uSrc;
uniform mat3 uOutput;
uniform int uTransfer;   // 0 linear, 1 sRGB, 2 gamma
uniform float uGamma;
uniform vec3 uFill;
${COLOR_LIB}
void main() {
  vec4 s = texture(uSrc, vUv);
  vec3 d = clamp(uOutput * s.rgb, 0.0, 1.0);
  if (uTransfer == 1) d = srgbEncode3(d);
  else if (uTransfer == 2) d = pow(d, vec3(1.0 / uGamma));
  if (s.a == 0.0) d = uFill;
  outColor = vec4(d, 1.0);
}`;
