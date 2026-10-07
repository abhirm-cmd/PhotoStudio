import type { PhotoExif } from '@shared/types';

export function formatShutter(s?: number) {
  if (!s) return '';
  if (s >= 1) return `${Math.round(s * 10) / 10}s`;
  return `1/${Math.round(1 / s)}`;
}

export function formatExposure(e: PhotoExif) {
  return [e.focalLength ? `${Math.round(e.focalLength)}mm` : '', e.aperture ? `f/${e.aperture.toFixed(1).replace(/\.0$/, '')}` : '', formatShutter(e.shutter), e.iso ? `ISO ${e.iso}` : ''].filter(Boolean).join('  ');
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function formatDate(iso?: string | null, withTime = true) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, withTime ? { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' } : { year: 'numeric', month: 'short', day: 'numeric' });
}
