/**
 * Camera/rendering profiles. A profile defines how scene-referred RAW data is
 * rendered to display-referred values (baseline exposure, tone-map white point,
 * base contrast and saturation). Camera-specific profiles (e.g. from DCP/ICC
 * calibration) can be registered at runtime with the same shape plus an optional
 * input matrix.
 */
export interface CameraProfile {
  id: string;
  name: string;
  group: 'raw' | 'any';
  kind: 'display' | 'tonemap' | 'linear';
  baseline: number;   // EV
  contrast: number;   // -1..1 added to contrast
  saturation: number; // -1..1 added to saturation
  mono?: boolean;
  /** Optional camera RGB → working space correction applied after decode */
  matrix?: number[];
  description: string;
}

export const PROFILES: CameraProfile[] = [
  { id: 'photostudio-standard', name: 'PhotoStudio Standard', group: 'raw', kind: 'tonemap', baseline: 0.75, contrast: 0.16, saturation: 0.04, description: 'Balanced contrast and color — a great starting point.' },
  { id: 'photostudio-neutral', name: 'PhotoStudio Neutral', group: 'raw', kind: 'tonemap', baseline: 0.65, contrast: 0, saturation: -0.04, description: 'Low contrast, maximum latitude for grading.' },
  { id: 'photostudio-vivid', name: 'PhotoStudio Vivid', group: 'raw', kind: 'tonemap', baseline: 0.75, contrast: 0.3, saturation: 0.18, description: 'Punchy contrast and saturated color.' },
  { id: 'photostudio-portrait', name: 'PhotoStudio Portrait', group: 'raw', kind: 'tonemap', baseline: 0.8, contrast: 0.1, saturation: -0.02, description: 'Softer contrast with flattering skin rendering.' },
  { id: 'photostudio-landscape', name: 'PhotoStudio Landscape', group: 'raw', kind: 'tonemap', baseline: 0.7, contrast: 0.24, saturation: 0.12, description: 'Crisp contrast with rich greens and blues.' },
  { id: 'photostudio-mono', name: 'PhotoStudio Monochrome', group: 'raw', kind: 'tonemap', baseline: 0.75, contrast: 0.22, saturation: 0, mono: true, description: 'Classic black & white conversion.' },
  { id: 'linear', name: 'Linear (scene-referred)', group: 'raw', kind: 'linear', baseline: 0, contrast: 0, saturation: 0, description: 'No tone mapping. For technical work.' },
  { id: 'embedded', name: 'Embedded (as encoded)', group: 'any', kind: 'display', baseline: 0, contrast: 0, saturation: 0, description: 'Uses the image as encoded by the camera or editor.' },
  { id: 'embedded-mono', name: 'Monochrome', group: 'any', kind: 'display', baseline: 0, contrast: 0.1, saturation: 0, mono: true, description: 'Black & white conversion.' },
];

const registry = new Map(PROFILES.map(p => [p.id, p]));
export function registerProfile(p: CameraProfile) { registry.set(p.id, p); }
export function getProfile(id: string, isRaw: boolean): CameraProfile {
  const p = registry.get(id);
  if (p && (isRaw || p.group === 'any')) return p;
  return registry.get(isRaw ? 'photostudio-standard' : 'embedded')!;
}
export function profilesFor(isRaw: boolean): CameraProfile[] {
  return [...registry.values()].filter(p => isRaw || p.group === 'any');
}
