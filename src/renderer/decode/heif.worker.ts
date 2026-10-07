/// <reference lib="webworker" />
// HEIC/HEIF decoding via libheif (LGPL-3.0, loaded as a separate WebAssembly module).
// @ts-ignore - no types shipped
import libheifFactory from 'libheif-js/libheif-wasm/libheif-bundle.mjs';

let lib: any = null;
self.onmessage = async (ev: MessageEvent<{ id: number; bytes: Uint8Array }>) => {
  const { id, bytes } = ev.data;
  try {
    lib ??= typeof libheifFactory === 'function' ? await libheifFactory() : libheifFactory;
    const decoder = new lib.HeifDecoder();
    const images = decoder.decode(bytes);
    if (!images?.length) throw new Error('No image found in HEIF container');
    const img = images[0];
    const width = img.get_width(), height = img.get_height();
    const rgba = await new Promise<Uint8ClampedArray>((resolve, reject) => {
      img.display({ data: new Uint8ClampedArray(width * height * 4), width, height }, (d: any) => (d ? resolve(d.data) : reject(new Error('HEIF decode failed'))));
    });
    (self as any).postMessage({ id, width, height, rgba }, [rgba.buffer]);
  } catch (e: any) {
    (self as any).postMessage({ id, error: String(e?.message ?? e) });
  }
};
