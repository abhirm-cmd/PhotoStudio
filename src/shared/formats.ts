/**
 * File-format registry. Decoders register by extension, so adding a new RAW
 * format is a one-line change here plus (if LibRaw can't read it) a decoder.
 */

export type DecoderId = 'libraw' | 'browser' | 'heif' | 'tiff';

export interface FormatInfo { ext: string; label: string; raw: boolean; decoder: DecoderId; vendor?: string }

export const FORMATS: FormatInfo[] = [
  { ext: 'cr2', label: 'Canon CR2', raw: true, decoder: 'libraw', vendor: 'Canon' },
  { ext: 'cr3', label: 'Canon CR3', raw: true, decoder: 'libraw', vendor: 'Canon' },
  { ext: 'crw', label: 'Canon CRW', raw: true, decoder: 'libraw', vendor: 'Canon' },
  { ext: 'arw', label: 'Sony ARW', raw: true, decoder: 'libraw', vendor: 'Sony' },
  { ext: 'srf', label: 'Sony SRF', raw: true, decoder: 'libraw', vendor: 'Sony' },
  { ext: 'sr2', label: 'Sony SR2', raw: true, decoder: 'libraw', vendor: 'Sony' },
  { ext: 'raf', label: 'Fujifilm RAF', raw: true, decoder: 'libraw', vendor: 'Fujifilm' },
  { ext: 'nef', label: 'Nikon NEF', raw: true, decoder: 'libraw', vendor: 'Nikon' },
  { ext: 'nrw', label: 'Nikon NRW', raw: true, decoder: 'libraw', vendor: 'Nikon' },
  { ext: 'orf', label: 'Olympus ORF', raw: true, decoder: 'libraw', vendor: 'OM System' },
  { ext: 'rw2', label: 'Panasonic RW2', raw: true, decoder: 'libraw', vendor: 'Panasonic' },
  { ext: 'pef', label: 'Pentax PEF', raw: true, decoder: 'libraw', vendor: 'Pentax' },
  { ext: 'dng', label: 'Adobe DNG', raw: true, decoder: 'libraw' },
  { ext: 'srw', label: 'Samsung SRW', raw: true, decoder: 'libraw', vendor: 'Samsung' },
  { ext: 'rwl', label: 'Leica RWL', raw: true, decoder: 'libraw', vendor: 'Leica' },
  { ext: '3fr', label: 'Hasselblad 3FR', raw: true, decoder: 'libraw', vendor: 'Hasselblad' },
  { ext: 'iiq', label: 'Phase One IIQ', raw: true, decoder: 'libraw', vendor: 'Phase One' },
  { ext: 'x3f', label: 'Sigma X3F', raw: true, decoder: 'libraw', vendor: 'Sigma' },
  { ext: 'kdc', label: 'Kodak KDC', raw: true, decoder: 'libraw', vendor: 'Kodak' },
  { ext: 'jpg', label: 'JPEG', raw: false, decoder: 'browser' },
  { ext: 'jpeg', label: 'JPEG', raw: false, decoder: 'browser' },
  { ext: 'png', label: 'PNG', raw: false, decoder: 'browser' },
  { ext: 'webp', label: 'WebP', raw: false, decoder: 'browser' },
  { ext: 'avif', label: 'AVIF', raw: false, decoder: 'browser' },
  { ext: 'tif', label: 'TIFF', raw: false, decoder: 'tiff' },
  { ext: 'tiff', label: 'TIFF', raw: false, decoder: 'tiff' },
  { ext: 'heic', label: 'HEIC', raw: false, decoder: 'heif' },
  { ext: 'heif', label: 'HEIF', raw: false, decoder: 'heif' },
];

const byExt = new Map(FORMATS.map(f => [f.ext, f]));

export function formatFor(pathOrExt: string): FormatInfo | undefined {
  const ext = pathOrExt.includes('.') ? pathOrExt.slice(pathOrExt.lastIndexOf('.') + 1) : pathOrExt;
  return byExt.get(ext.toLowerCase());
}

export const isSupported = (p: string) => !!formatFor(p);
export const isRawFile = (p: string) => !!formatFor(p)?.raw;
