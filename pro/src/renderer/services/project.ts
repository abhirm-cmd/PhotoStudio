/** New / open / save / autosave / recovery. Saving never touches media files; projects only reference them. */
import { newProject, normalizeProject, type Project } from '@shared/project';
import { api } from '../api';
import { useProject, P } from '../store/project';
import { usePlayer } from '../store/player';
import { toast } from '../store/ui';
import { enqueueAnalysis } from './media';

export async function saveProject(saveAs = false): Promise<boolean> {
  const s = useProject.getState();
  try {
    const file = await api.saveProject(s.project, s.file, saveAs);
    if (!file) return false;
    const name = file.split(/[\\/]/).pop()!.replace(/\.psproj$/i, '');
    if (s.project.name !== name && (saveAs || !s.file)) useProject.setState(st => ({ project: { ...st.project, name } }));
    useProject.getState().markSaved(file);
    await api.clearAutosave();
    toast({ kind: 'success', title: 'Project saved', body: file });
    return true;
  } catch (e: any) {
    toast({ kind: 'error', title: "Couldn't save the project", body: String(e?.message ?? e) }, 9000);
    return false;
  }
}

/** Resolves true when it's fine to discard the current project. */
export let askUnsaved: (() => Promise<'save' | 'discard' | 'cancel'>) | null = null;
export const setAskUnsaved = (f: typeof askUnsaved) => { askUnsaved = f; };

export async function confirmDiscard(): Promise<boolean> {
  if (!useProject.getState().dirty) return true;
  const a = askUnsaved ? await askUnsaved() : 'cancel';
  if (a === 'cancel') return false;
  if (a === 'save') return saveProject();
  return true;
}

function adopt(p: Project, file: string | null, dirty = false) {
  useProject.getState().load(p, file, dirty);
  usePlayer.setState({ frame: 0, playing: false, sourceId: null });
  enqueueAnalysis(p.media.filter(m => !m.missing && (!m.thumbs || (m.hasAudio && !m.waveform))));
}

export async function newProjectFlow(settings?: Partial<Project['settings']>) {
  if (!(await confirmDiscard())) return;
  adopt(newProject('Untitled', settings), null);
  await api.clearAutosave();
}

export async function openProject(file?: string) {
  if (!(await confirmDiscard())) return;
  try {
    const r = await api.openProject(file);
    if (!r) return;
    adopt(r.project, r.file);
    const missing = r.project.media.filter(m => m.missing).length;
    if (missing) toast({ kind: 'error', title: `${missing} media file${missing > 1 ? 's are' : ' is'} offline`, body: 'Relink them from the Media page.' }, 8000);
  } catch (e: any) {
    toast({ kind: 'error', title: "Couldn't open the project", body: String(e?.message ?? e) }, 9000);
  }
}

export async function recoverAutosave(): Promise<boolean> {
  const r = await api.recover();
  if (!r?.project) return false;
  const p = normalizeProject(r.project);
  const ok = await api.exists(p.media.map(m => m.path));
  p.media.forEach((m, i) => { m.missing = !ok[i]; });
  adopt(p, r.file, true);
  toast({ kind: 'success', title: 'Recovered unsaved changes', body: `From ${new Date(r.savedAt).toLocaleString()}` });
  return true;
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startAutosave(ms = 20000) {
  if (timer) return;
  timer = setInterval(() => {
    const s = useProject.getState();
    if (s.dirty) void api.autosave(P(), s.file).catch(() => {});
  }, ms);
}
