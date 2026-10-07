/**
 * Minimal ICC v2 matrix/TRC display profile writer.
 * Lets exports embed correct, license-free profiles for sRGB, Display P3,
 * Adobe RGB (1998)-compatible and ProPhoto-compatible color spaces.
 */
import { SPACES, rgbToXyzD50, xyToXYZ, WHITE_D50, type RgbSpace } from '../src/shared/color';

function s15f16(v: number) { return Math.round(v * 65536) | 0; }

class Writer {
  parts: number[] = [];
  u8(v: number) { this.parts.push(v & 255); }
  u16(v: number) { this.u8(v >> 8); this.u8(v); }
  u32(v: number) { this.u16((v >>> 16) & 0xffff); this.u16(v & 0xffff); }
  s32(v: number) { this.u32(v >>> 0); }
  str(s: string, len: number) { for (let i = 0; i < len; i++) this.u8(i < s.length ? s.charCodeAt(i) : 0); }
  pad4() { while (this.parts.length % 4) this.u8(0); }
  get length() { return this.parts.length; }
  bytes() { return Uint8Array.from(this.parts); }
}

function xyzTag(xyz: number[]) { const w = new Writer(); w.str('XYZ ', 4); w.u32(0); for (const v of xyz) w.s32(s15f16(v)); return w.bytes(); }
function textDesc(s: string) {
  const w = new Writer(); w.str('desc', 4); w.u32(0); w.u32(s.length + 1); w.str(s, s.length + 1);
  w.u32(0); w.u32(0); w.u16(0); w.u8(0); for (let i = 0; i < 67; i++) w.u8(0); return w.bytes();
}
function text(s: string) { const w = new Writer(); w.str('text', 4); w.u32(0); w.str(s, s.length + 1); return w.bytes(); }
function curve(gamma: 'srgb' | number) {
  const w = new Writer(); w.str('curv', 4); w.u32(0);
  if (typeof gamma === 'number') { w.u32(1); w.u16(Math.round(gamma * 256)); }
  else {
    const n = 1024; w.u32(n);
    for (let i = 0; i < n; i++) { const v = i / (n - 1); const lin = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); w.u16(Math.round(lin * 65535)); }
  }
  return w.bytes();
}

export function buildIccProfile(space: RgbSpace): Uint8Array {
  const m = rgbToXyzD50(space);
  const tags: [string, Uint8Array][] = [
    ['desc', textDesc(space.name)],
    ['cprt', text('No copyright, use freely')],
    ['wtpt', xyzTag(xyToXYZ(WHITE_D50))],
    ['rXYZ', xyzTag([m[0], m[3], m[6]])],
    ['gXYZ', xyzTag([m[1], m[4], m[7]])],
    ['bXYZ', xyzTag([m[2], m[5], m[8]])],
  ];
  const trc = curve(space.gamma);
  const headerSize = 128, tableSize = 4 + 12 * (tags.length + 3);
  let offset = headerSize + tableSize;
  const entries: { sig: string; off: number; size: number; data?: Uint8Array }[] = [];
  const pad = (n: number) => (n + 3) & ~3;
  for (const [sig, data] of tags) { entries.push({ sig, off: offset, size: data.length, data }); offset += pad(data.length); }
  const trcOff = offset; offset += pad(trc.length);
  for (const sig of ['rTRC', 'gTRC', 'bTRC']) entries.push({ sig, off: trcOff, size: trc.length });
  const total = offset;
  const w = new Writer();
  w.u32(total); w.str('lcms', 4); w.u32(0x02100000); w.str('mntr', 4); w.str('RGB ', 4); w.str('XYZ ', 4);
  const d = new Date(); w.u16(d.getUTCFullYear()); w.u16(d.getUTCMonth() + 1); w.u16(d.getUTCDate()); w.u16(d.getUTCHours()); w.u16(d.getUTCMinutes()); w.u16(d.getUTCSeconds());
  w.str('acsp', 4); w.str('APPL', 4); w.u32(0); w.u32(0); w.u32(0); w.u32(0); w.u32(0); w.u32(0); w.u32(0);
  for (const v of xyToXYZ(WHITE_D50)) w.s32(s15f16(v));
  w.str('lumo', 4);
  while (w.length < 128) w.u8(0);
  w.u32(entries.length);
  for (const e of entries) { w.str(e.sig, 4); w.u32(e.off); w.u32(e.size); }
  for (const e of entries) if (e.data) { for (const b of e.data) w.u8(b); w.pad4(); }
  for (const b of trc) w.u8(b); w.pad4();
  return w.bytes();
}

const cache = new Map<string, Uint8Array>();
export function iccFor(id: string): Uint8Array {
  if (!cache.has(id)) cache.set(id, buildIccProfile(SPACES[id] ?? SPACES.srgb));
  return cache.get(id)!;
}
