import React from 'react';
import { useDevelop } from '../../store/develop';
import { Slider, type SliderProps } from '../../components/ui';
import type { EditParams } from '@shared/edit';

type Get = (e: EditParams) => number;
type Put = (e: EditParams, v: number) => void;

/** A slider bound to one numeric field of the current edit. Commits a history step on release. */
export function EditSlider({ get, put, label, ...rest }: { get: Get; put: Put; label: string } & Omit<SliderProps, 'value' | 'onChange' | 'onCommit' | 'label'>) {
  const value = useDevelop(s => get(s.edit));
  const setEdit = useDevelop(s => s.setEdit);
  return (
    <Slider label={label} value={value} {...rest}
      onChange={v => setEdit(e => put(e, v))}
      onCommit={() => useDevelop.getState().commit()} />
  );
}

/** Shorthand for a top-level numeric key. */
export function KeySlider({ k, label, min = -100, max = 100, step = 1, def = 0, ...rest }: { k: keyof EditParams; label: string; min?: number; max?: number; step?: number; def?: number } & Partial<Omit<SliderProps, 'value' | 'onChange' | 'label'>>) {
  return <EditSlider label={label} min={min} max={max} step={step} defaultValue={def} get={e => e[k] as number} put={(e, v) => { (e as any)[k] = v; }} {...rest} />;
}

/** Slider for a nested numeric path, e.g. ['effects', 'clarity']. */
export function PathSlider({ path, label, min = -100, max = 100, step = 1, def = 0, ...rest }: { path: string[]; label: string; min?: number; max?: number; step?: number; def?: number } & Partial<Omit<SliderProps, 'value' | 'onChange' | 'label'>>) {
  const get: Get = e => path.reduce((o: any, k) => o[k], e) as number;
  const put: Put = (e, v) => { const o = path.slice(0, -1).reduce((o: any, k) => o[k], e); o[path[path.length - 1]] = v; };
  return <EditSlider label={label} min={min} max={max} step={step} defaultValue={def} get={get} put={put} {...rest} />;
}

export const G = {
  temp: 'linear-gradient(90deg, #3d6fd8, #c9d0db 50%, #e6b23e)',
  tint: 'linear-gradient(90deg, #3fae4c, #c9d0db 50%, #c64bc3)',
  sat: 'linear-gradient(90deg, #8a8a8a, #c96b5e 50%, #e8443a)',
  vib: 'linear-gradient(90deg, #8a8a8a, #64a7d8 50%, #2f8fe8)',
  lum: 'linear-gradient(90deg, #1b1b1d, #f0f0f0)',
  hue: 'linear-gradient(90deg, #e04848, #e0b048, #8ae048, #48e0c0, #4870e0, #b048e0, #e04890)',
};

export function SubHead({ children }: { children: React.ReactNode }) { return <div className="subhead">{children}</div>; }
