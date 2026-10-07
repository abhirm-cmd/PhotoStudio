import type { Catalog } from './catalog';
import { BUILTIN_PRESETS } from '../src/shared/builtinPresets';

export function seedBuiltinPresets(catalog: Catalog) {
  catalog.tx(() => { for (const p of BUILTIN_PRESETS) catalog.savePreset(p); });
}
