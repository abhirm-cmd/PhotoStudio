/// <reference lib="webworker" />
/**
 * Runs the bundled U²-Net segmentation model with ONNX Runtime Web (WASM).
 * Everything happens in this worker on the user's machine; no network access.
 */
import * as ort from 'onnxruntime-web/wasm';

let session: Promise<ort.InferenceSession> | null = null;

function load(base: string) {
  ort.env.logLevel = 'error';
  ort.env.wasm.wasmPaths = new URL('vendor/ort/', base).href;
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)) : 1;
  return (async () => {
    const res = await fetch(new URL('models/silueta.onnx', base));
    if (!res.ok) throw new Error(`Segmentation model is missing (${res.status})`);
    return ort.InferenceSession.create(new Uint8Array(await res.arrayBuffer()), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  })();
}

self.onmessage = async ({ data }: MessageEvent<{ id: number; base: string; size: number; input: Float32Array }>) => {
  try {
    session ??= load(data.base);
    const s = await session.catch(e => { session = null; throw e; });
    const t = new ort.Tensor('float32', data.input, [1, 3, data.size, data.size]);
    const r = await s.run({ [s.inputNames[0]]: t });
    const out = r[s.outputNames[0]].data as Float32Array;
    const copy = Float32Array.from(out);
    for (const k of Object.keys(r)) r[k].dispose?.();
    (self as any).postMessage({ id: data.id, out: copy }, [copy.buffer]);
  } catch (e: any) {
    (self as any).postMessage({ id: data.id, error: String(e?.message ?? e) });
  }
};
