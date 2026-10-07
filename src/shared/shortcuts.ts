/** Action id → key combo. Combos use "Mod" for Ctrl (Win/Linux) / Cmd (macOS). */
export const DEFAULT_SHORTCUTS: Record<string, string> = {
  'workspace.library': 'G',
  'workspace.develop': 'D',
  'workspace.masking': 'M',
  'workspace.color': 'C',
  'workspace.presets': 'Shift+P',
  'workspace.reference': 'Shift+R',
  'workspace.compare': 'Shift+C',
  'workspace.export': 'Mod+Shift+E',
  'view.loupe': 'E',
  'view.survey': 'N',
  'view.fullscreen': 'F',
  'view.zoomToggle': 'Z',
  'view.zoomIn': 'Mod+=',
  'view.zoomOut': 'Mod+-',
  'view.fit': 'Mod+0',
  'view.clipping': 'J',
  'view.beforeAfter': '\\',
  'view.splitCycle': 'Y',
  'view.togglePanels': 'Tab',
  'tool.crop': 'R',
  'tool.mask': 'Shift+M',
  'tool.wbPicker': 'W',
  'tool.brush': 'K',
  'flag.pick': 'P',
  'flag.reject': 'X',
  'flag.unflag': 'U',
  'rate.0': '0',
  'rate.1': '1',
  'rate.2': '2',
  'rate.3': '3',
  'rate.4': '4',
  'rate.5': '5',
  'label.red': '6',
  'label.yellow': '7',
  'label.green': '8',
  'label.blue': '9',
  'favorite.toggle': 'H',
  'nav.next': 'ArrowRight',
  'nav.prev': 'ArrowLeft',
  'nav.up': 'ArrowUp',
  'nav.down': 'ArrowDown',
  'edit.undo': 'Mod+Z',
  'edit.redo': 'Mod+Shift+Z',
  'edit.save': 'Mod+S',
  'edit.copySettings': 'Mod+Shift+C',
  'edit.pasteSettings': 'Mod+Shift+V',
  'edit.syncSettings': 'Mod+Shift+S',
  'edit.reset': 'Mod+Shift+R',
  'edit.autoTone': 'Mod+U',
  'edit.virtualCopy': "Mod+'",
  'edit.autoEnhance': 'Mod+Shift+A',
  'library.selectAll': 'Mod+A',
  'library.deselect': 'Mod+D',
  'library.import': 'Mod+Shift+I',
  'library.search': 'Mod+F',
  'app.settings': 'Mod+,',
  'app.shortcuts': 'Mod+/',
};

export const SHORTCUT_LABELS: Record<string, string> = {
  'workspace.library': 'Library (grid)', 'workspace.develop': 'Develop', 'workspace.masking': 'Masking', 'workspace.color': 'Color',
  'workspace.presets': 'Presets', 'workspace.reference': 'Reference Grade', 'workspace.compare': 'Compare', 'workspace.export': 'Export',
  'view.loupe': 'Loupe view', 'view.survey': 'Survey view', 'view.fullscreen': 'Full screen', 'view.zoomToggle': 'Toggle zoom (fit / 100%)',
  'view.zoomIn': 'Zoom in', 'view.zoomOut': 'Zoom out', 'view.fit': 'Fit to screen', 'view.clipping': 'Clipping warnings',
  'view.beforeAfter': 'Before / After', 'view.splitCycle': 'Cycle compare mode', 'view.togglePanels': 'Hide / show panels',
  'tool.crop': 'Crop tool', 'tool.mask': 'New mask', 'tool.wbPicker': 'White balance picker', 'tool.brush': 'Brush mask',
  'flag.pick': 'Flag as pick', 'flag.reject': 'Flag as reject', 'flag.unflag': 'Remove flag',
  'rate.0': 'Clear rating', 'rate.1': '1 star', 'rate.2': '2 stars', 'rate.3': '3 stars', 'rate.4': '4 stars', 'rate.5': '5 stars',
  'label.red': 'Red label', 'label.yellow': 'Yellow label', 'label.green': 'Green label', 'label.blue': 'Blue label', 'favorite.toggle': 'Toggle favorite',
  'nav.next': 'Next photo', 'nav.prev': 'Previous photo', 'nav.up': 'Up (grid)', 'nav.down': 'Down (grid)',
  'edit.undo': 'Undo', 'edit.redo': 'Redo', 'edit.save': 'Save metadata', 'edit.copySettings': 'Copy settings', 'edit.pasteSettings': 'Paste settings',
  'edit.syncSettings': 'Sync settings to selection', 'edit.reset': 'Reset all settings', 'edit.autoTone': 'Auto tone', 'edit.virtualCopy': 'Create virtual copy',
  'edit.autoEnhance': 'AI Auto Enhance', 'library.selectAll': 'Select all', 'library.deselect': 'Deselect all', 'library.import': 'Import photos',
  'library.search': 'Search', 'app.settings': 'Settings', 'app.shortcuts': 'Keyboard shortcuts',
};

export function normalizeCombo(e: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }, isMac: boolean): string {
  const parts: string[] = [];
  if (isMac ? e.metaKey : e.ctrlKey) parts.push('Mod');
  if (isMac && e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  let key = e.key;
  if (key === ' ') key = 'Space';
  if (key.length === 1) key = key.toUpperCase();
  // Shift changes the produced character for digits/symbols on most layouts; keep Shift only for letters & named keys.
  if (e.shiftKey && (key.length > 1 || /[A-Z]/.test(key))) parts.push('Shift');
  if (['Control', 'Meta', 'Shift', 'Alt'].includes(key)) return parts.join('+');
  const shiftedDigits: Record<string, string> = { '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0' };
  if (e.shiftKey && shiftedDigits[key]) { parts.push('Shift'); key = shiftedDigits[key]; }
  if (key === '+') key = '=';
  parts.push(key);
  return parts.join('+');
}
