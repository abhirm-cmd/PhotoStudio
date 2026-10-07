/** Mask document operations (pure edits on the current photo's mask stack). */
import { useDevelop } from '../store/develop';
import { useApp } from '../store/app';
import { defaultLocal, uid, type Mask, type MaskComponent, type MaskOp, type AiMaskTarget, type Vec2 } from '@shared/edit';
import { MAX_MASKS } from '../engine/params';
import { generateMask, NoResultError } from '../analysis/segmentation';
import { host } from '../engine/host';
import { computeGeometry, outToSrc, orientationMatrix } from '../engine/geometry';

export type NewKind = 'linear' | 'radial' | 'brush' | 'color' | 'luminance' | 'all' | AiMaskTarget;

export const AI_TARGETS: { id: AiMaskTarget; label: string }[] = [
  { id: 'subject', label: 'Subject' }, { id: 'sky', label: 'Sky' }, { id: 'background', label: 'Background' },
  { id: 'people', label: 'People' }, { id: 'object', label: 'Object' },
];

export const KIND_LABEL: Record<string, string> = {
  linear: 'Linear Gradient', radial: 'Radial Gradient', brush: 'Brush', color: 'Color Range', luminance: 'Luminance Range', all: 'Whole Image',
  subject: 'Subject', sky: 'Sky', background: 'Background', people: 'People', object: 'Object', skin: 'Skin', face: 'Face', eyes: 'Eyes', teeth: 'Teeth', hair: 'Hair', clothing: 'Clothing',
};

export const busyMask = { current: null as string | null, listeners: new Set<() => void>() };
const setBusy = (v: string | null) => { busyMask.current = v; busyMask.listeners.forEach(f => f()); };

function baseComponent(kind: NewKind, op: MaskOp): MaskComponent | null {
  const id = uid('c');
  switch (kind) {
    case 'linear': return { id, type: 'linear', op, invert: false, a: [0.5, 0.25], b: [0.5, 0.6] };
    case 'radial': return { id, type: 'radial', op, invert: false, cx: 0.5, cy: 0.5, rx: 0.22, ry: 0.22, angle: 0, feather: 50 };
    case 'brush': return { id, type: 'brush', op, invert: false, dabs: [] };
    case 'color': return { id, type: 'color', op, invert: false, samples: [], range: 0.4 };
    case 'luminance': return { id, type: 'luminance', op, invert: false, min: 0.65, max: 1.0, feather: 30 };
    case 'all': return { id, type: 'all', op, invert: false };
    default: return null;
  }
}

/** Interactive kinds start the corresponding tool so the user can place them. */
const TOOL_FOR: Partial<Record<NewKind, any>> = { brush: 'brush', color: 'color-pick', luminance: 'none', linear: 'linear', radial: 'radial', object: 'object' };

export async function createMask(kind: NewKind) {
  const dev = useDevelop.getState();
  if (dev.photoId == null) return;
  if (dev.edit.masks.length >= MAX_MASKS) { useApp.getState().toast({ kind: 'info', title: `Up to ${MAX_MASKS} masks per photo`, body: 'Combine areas inside one mask with Add / Subtract.' }); return; }
  const n = dev.edit.masks.length + 1;
  const mask: Mask = { id: uid('m'), name: KIND_LABEL[kind] ?? `Mask ${n}`, visible: true, invert: false, density: 100, feather: 0, refine: 0, components: [], adjust: defaultLocal() };
  if (kind === 'object') {
    dev.setEdit(e => { e.masks.push(mask); });
    dev.set({ selectedMask: mask.id, selectedComponent: null, tool: 'object' });
    return;
  }
  const comp = baseComponent(kind, 'add');
  if (comp) {
    mask.components.push(comp);
    dev.setEdit(e => { e.masks.push(mask); }, `New Mask: ${mask.name}`);
    dev.set({ selectedMask: mask.id, selectedComponent: comp.id, tool: TOOL_FOR[kind] ?? 'none' });
    return;
  }
  // AI target: generate the bitmap first
  dev.setEdit(e => { e.masks.push(mask); });
  dev.set({ selectedMask: mask.id });
  const ok = await addAiComponent(mask.id, kind as AiMaskTarget, 'add');
  if (!ok) useDevelop.getState().setEdit(e => { e.masks = e.masks.filter(m => m.id !== mask.id); });
}

export async function addComponent(maskId: string, kind: NewKind, op: MaskOp) {
  const dev = useDevelop.getState();
  if (kind === 'object') { dev.set({ selectedMask: maskId, tool: 'object' }); pendingObjectOp = op; return; }
  const comp = baseComponent(kind, op);
  if (comp) {
    dev.setEdit(e => { e.masks.find(m => m.id === maskId)?.components.push(comp); }, `Mask: ${op} ${KIND_LABEL[kind]}`);
    dev.set({ selectedMask: maskId, selectedComponent: comp.id, tool: TOOL_FOR[kind] ?? 'none' });
    return;
  }
  await addAiComponent(maskId, kind as AiMaskTarget, op);
}

export let pendingObjectOp: MaskOp = 'add';
export const resetObjectOp = () => { pendingObjectOp = 'add'; };

export async function addAiComponent(maskId: string, target: AiMaskTarget, op: MaskOp, box?: [number, number, number, number]): Promise<boolean> {
  const dev = useDevelop.getState();
  const id = dev.photoId;
  if (id == null) return false;
  const key = `ai:${id}:${target}:${uid()}`;
  setBusy(`Detecting ${KIND_LABEL[target].toLowerCase()}…`);
  try {
    const r = await generateMask(target, key, { box });
    const comp: MaskComponent = { id: uid('c'), type: 'ai', op, invert: false, target, ref: key, provider: r.engine };
    useDevelop.getState().setEdit(e => { e.masks.find(m => m.id === maskId)?.components.push(comp); }, `Mask: ${KIND_LABEL[target]}`);
    useDevelop.getState().set({ selectedMask: maskId, selectedComponent: comp.id });
    useApp.getState().toast({ kind: 'success', title: `${KIND_LABEL[target]} selected`, body: `${r.engine} · ${Math.round(r.ms)} ms. Refine with Add / Subtract if needed.` });
    return true;
  } catch (e: any) {
    useApp.getState().toast({ kind: e instanceof NoResultError ? 'info' : 'error', title: e?.message ?? 'Mask generation failed', body: e instanceof NoResultError ? undefined : 'Please try again.' });
    return false;
  } finally { setBusy(null); }
}

/** Re-run detection for an AI component (e.g. after changing the photo's crop). */
export async function regenerateAi(maskId: string, compId: string) {
  const dev = useDevelop.getState();
  const c = dev.edit.masks.find(m => m.id === maskId)?.components.find(x => x.id === compId);
  if (!c || c.type !== 'ai' || c.target === 'object') return;
  setBusy(`Updating ${KIND_LABEL[c.target].toLowerCase()}…`);
  try { await generateMask(c.target, c.ref); useDevelop.getState().commit(`Mask: refresh ${KIND_LABEL[c.target]}`); }
  catch (e: any) { useApp.getState().toast({ kind: 'info', title: e?.message ?? 'Detection failed' }); }
  finally { setBusy(null); }
}

export function updateMask(maskId: string, fn: (m: Mask) => void, label?: string) {
  useDevelop.getState().setEdit(e => { const m = e.masks.find(x => x.id === maskId); if (m) fn(m); }, label);
}
export function updateComponent(maskId: string, compId: string, fn: (c: MaskComponent) => void, label?: string) {
  updateMask(maskId, m => { const c = m.components.find(x => x.id === compId); if (c) fn(c); }, label);
}

export function deleteMask(maskId: string) {
  const dev = useDevelop.getState();
  dev.setEdit(e => { e.masks = e.masks.filter(m => m.id !== maskId); }, 'Delete Mask');
  if (dev.selectedMask === maskId) dev.set({ selectedMask: useDevelop.getState().edit.masks[0]?.id ?? null, selectedComponent: null, tool: 'none' });
}
export function duplicateMask(maskId: string) {
  const dev = useDevelop.getState();
  const m = dev.edit.masks.find(x => x.id === maskId);
  if (!m || dev.edit.masks.length >= MAX_MASKS) return;
  const copy: Mask = { ...structuredClone(m), id: uid('m'), name: `${m.name} copy`, components: m.components.map(c => ({ ...structuredClone(c), id: uid('c') })) };
  dev.setEdit(e => { e.masks.push(copy); }, 'Duplicate Mask');
  dev.set({ selectedMask: copy.id });
}

/* -------------------------------------------------------- coordinates */

/** Geometry of the current view (with crop applied), for mapping handles. */
export function viewGeometry() {
  const dev = useDevelop.getState();
  const src = host().renderer?.source;
  if (!src) return null;
  const e = dev.previewEdit ?? dev.edit;
  return { g: computeGeometry(e, src.width, src.height, host().renderContext(e).lens), srcW: src.width, srcH: src.height };
}

/** Output uv → analysis-frame uv (oriented, uncropped, no transform) — used for the object box. */
export function outUvToFrameUv(uv: Vec2): Vec2 | null {
  const vg = viewGeometry();
  if (!vg) return null;
  const s = outToSrc(vg.g, uv);
  const e = useDevelop.getState().edit;
  const o = ((e.crop.orientation % 360) + 360) % 360;
  const F = orientationMatrix(o, e.crop.flipH, e.crop.flipV);
  const sx = s[0] * vg.srcW - vg.srcW / 2, sy = s[1] * vg.srcH - vg.srcH / 2;
  const fw = o % 180 ? vg.srcH : vg.srcW, fh = o % 180 ? vg.srcW : vg.srcH;
  return [(F[0] * sx + F[1] * sy + fw / 2) / fw, (F[2] * sx + F[3] * sy + fh / 2) / fh];
}
