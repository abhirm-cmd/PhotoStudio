import React, { useEffect } from 'react';
import { Crop, Pipette, Layers, Sparkles, Copy, ClipboardPaste, RotateCcw, Undo2, Redo2 } from 'lucide-react';
import { useLibrary, activePhoto } from '../store/library';
import { useDevelop } from '../store/develop';
import { useApp } from '../store/app';
import { host } from '../engine/host';
import { SidePanel } from '../components/Panel';
import { Viewer } from '../develop/Viewer';
import { Histogram } from '../develop/Histogram';
import { BasicPanel, ProfileRow, WhiteBalance } from '../develop/panels/BasicPanel';
import { ToneCurvePanel } from '../develop/panels/ToneCurvePanel';
import { HslPanel, GradingPanel, CalibrationPanel } from '../develop/panels/ColorPanels';
import { DetailPanel, OpticsPanel, TransformPanel, EffectsPanel, CropPanel } from '../develop/panels/MorePanels';
import { PortraitPanel } from '../develop/panels/PortraitPanel';
import { MaskingPanel, MaskOverlay } from '../masking/MaskingPanel';
import { Navigator, PresetsSection, SnapshotsSection, HistorySection } from '../develop/LeftPanels';
import { GuidesOverlay, TargetedOverlay } from '../develop/ToolOverlays';
import { Section, Empty } from '../components/ui';
import { goWorkspace } from '../services/actions';
import { runAutoEnhance } from '../analysis/enhance';

/** Load the active photo into the editor whenever it changes. */
export function useEditorPhoto() {
  const activeId = useLibrary(s => s.activeId);
  const photo = useLibrary(s => s.photos.find(p => p.id === s.activeId) ?? null);
  useEffect(() => {
    const p = activePhoto();
    if (!p) return;
    let cancelled = false;
    (async () => {
      await useDevelop.getState().load(p);
      if (!cancelled) await host().setPhoto(p);
    })();
    return () => { cancelled = true; };
  }, [activeId]);
  // Commit pending slider work when leaving the editor
  useEffect(() => () => { useDevelop.getState().commit(); useDevelop.getState().setPreview(null); }, []);
  return photo;
}

export function DevelopWorkspace({ mode }: { mode: 'develop' | 'masking' | 'color' }) {
  const photo = useEditorPhoto();
  const tool = useDevelop(s => s.tool);
  const photos = useLibrary(s => s.photos);

  useEffect(() => {
    // Leaving a tool that belongs to another workspace
    const dev = useDevelop.getState();
    if (mode !== 'masking' && ['brush', 'linear', 'radial', 'color-pick', 'lum-pick', 'object'].includes(dev.tool)) dev.set({ tool: 'none' });
  }, [mode]);

  if (!photos.length) {
    return <div className="center"><Empty kind="library" title="No photos to edit"><p>Import photos in the Library first.</p><button className="btn primary" onClick={() => goWorkspace('library')}>Go to Library</button></Empty></div>;
  }

  return (
    <>
      <SidePanel side="left">
        <Navigator />
        <PresetsSection />
        <SnapshotsSection />
        <HistorySection />
      </SidePanel>
      <div className="center">
        <Viewer photo={photo}>
          {tool === 'upright-guides' && <GuidesOverlay />}
          {tool === 'targeted' && <TargetedOverlay />}
          {mode === 'masking' && <MaskOverlay />}
        </Viewer>
      </div>
      <SidePanel side="right" header={<RightHeader mode={mode} />}>
        <Histogram photo={photo} />
        {tool === 'crop' && <CropPanel />}
        {mode === 'develop' && <>
          <BasicPanel />
          <ToneCurvePanel />
          <HslPanel />
          <GradingPanel />
          <DetailPanel />
          <OpticsPanel />
          <TransformPanel />
          <EffectsPanel />
          <PortraitPanel />
          <CalibrationPanel />
        </>}
        {mode === 'color' && <>
          <Section id="color.base" title="Base"><ProfileRow /><WhiteBalance /></Section>
          <ToneCurvePanel />
          <HslPanel />
          <GradingPanel />
          <CalibrationPanel />
        </>}
        {mode === 'masking' && <MaskingPanel />}
      </SidePanel>
    </>
  );
}

function RightHeader({ mode }: { mode: string }) {
  const tool = useDevelop(s => s.tool);
  const setTool = useDevelop(s => s.setTool);
  const canUndo = useDevelop(s => s.index > 0);
  const canRedo = useDevelop(s => s.index < s.history.length - 1);
  const dev = () => useDevelop.getState();
  return (
    <div className="toolstrip">
      <button className={`icon-btn${tool === 'crop' ? ' active' : ''}`} onClick={() => { if (mode === 'masking') goWorkspace('develop'); setTool('crop'); }} title="Crop & straighten (R)" aria-label="Crop"><Crop size={16} /></button>
      <button className={`icon-btn${tool === 'wb' ? ' active' : ''}`} onClick={() => setTool('wb')} title="White balance picker (W)" aria-label="White balance picker"><Pipette size={16} /></button>
      <button className={`icon-btn${mode === 'masking' ? ' active' : ''}`} onClick={() => goWorkspace(mode === 'masking' ? 'develop' : 'masking')} title="Masking (M)" aria-label="Masking"><Layers size={16} /></button>
      <button className="icon-btn" onClick={() => runAutoEnhance(0.7)} title="AI Auto Enhance" aria-label="AI Auto Enhance"><Sparkles size={16} className="accent" /></button>
      <span className="grow" />
      <button className="icon-btn" disabled={!canUndo} onClick={() => dev().undo()} title="Undo" aria-label="Undo"><Undo2 size={15} /></button>
      <button className="icon-btn" disabled={!canRedo} onClick={() => dev().redo()} title="Redo" aria-label="Redo"><Redo2 size={15} /></button>
      <button className="icon-btn" onClick={() => { dev().copySettings(); useApp.getState().toast({ kind: 'info', title: 'Settings copied' }); }} title="Copy settings" aria-label="Copy settings"><Copy size={15} /></button>
      <button className="icon-btn" disabled={!useDevelop.getState().clipboard} onClick={async () => { const n = await dev().pasteSettings([dev().photoId!]); if (n) useApp.getState().toast({ kind: 'success', title: 'Settings pasted' }); }} title="Paste settings" aria-label="Paste settings"><ClipboardPaste size={15} /></button>
      <button className="icon-btn" onClick={() => dev().resetAll()} title="Reset all settings" aria-label="Reset all"><RotateCcw size={15} /></button>
    </div>
  );
}
