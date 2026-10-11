/** Renders title clips to a canvas at project resolution. Used for the preview texture and the exported PNG. */
import type { TitleSpec } from '@shared/project';

const hexA = (hex: string, a: number) => {
  const n = parseInt(hex.replace('#', '').padEnd(6, '0').slice(0, 6), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

export function drawTitle(t: TitleSpec, W: number, H: number, canvas?: HTMLCanvasElement | OffscreenCanvas): HTMLCanvasElement | OffscreenCanvas {
  const c = canvas ?? document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d') as CanvasRenderingContext2D;
  g.clearRect(0, 0, W, H);
  const lines = (t.text || ' ').split('\n');
  g.font = `${t.weight} ${t.size}px "${t.font}", "Inter Variable", system-ui, sans-serif`;
  g.textBaseline = 'middle';
  g.textAlign = t.align;
  const lh = t.size * 1.18;
  const widths = lines.map(l => g.measureText(l).width);
  const bw = Math.max(...widths), bh = lh * lines.length;
  const cx = t.x * W, cy = t.y * H;
  const ax = t.align === 'left' ? cx - bw / 2 : t.align === 'right' ? cx + bw / 2 : cx;
  if (t.box) {
    const pad = t.size * 0.35;
    g.fillStyle = hexA(t.boxColor, t.boxOpacity);
    const r = t.size * 0.12, x = cx - bw / 2 - pad, y = cy - bh / 2 - pad * 0.6, w = bw + pad * 2, h = bh + pad * 1.2;
    g.beginPath(); g.roundRect(x, y, w, h, r); g.fill();
  }
  if (t.shadow) { g.shadowColor = 'rgba(0,0,0,0.55)'; g.shadowBlur = t.size * 0.12; g.shadowOffsetY = t.size * 0.04; }
  g.fillStyle = t.color;
  lines.forEach((l, i) => g.fillText(l, ax, cy - bh / 2 + lh * (i + 0.5)));
  return c;
}

export async function titlePng(t: TitleSpec, W: number, H: number): Promise<Uint8Array> {
  await document.fonts.ready;
  const c = drawTitle(t, W, H) as HTMLCanvasElement;
  const blob: Blob = await new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('Title render failed'))), 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}
