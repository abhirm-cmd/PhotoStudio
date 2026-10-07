import React from 'react';
import { SlidersHorizontal, Flag, X, Copy, ClipboardPaste, FolderOpen, Trash2, Heart, Layers, FolderPlus, RotateCw, Sparkles } from 'lucide-react';
import type { Photo } from '@shared/types';
import { confirmDialog, type MenuItem } from '../components/ui';
import { useLibrary } from '../store/library';
import { useDevelop } from '../store/develop';
import { useApp } from '../store/app';
import { api } from '../api';
import { goWorkspace, setFlag, toggleFavorite, createVirtualCopy, setRating } from '../services/actions';

export async function removeFromCatalog(ids: number[]) {
  const app = useApp.getState();
  const n = ids.length;
  if (app.settings?.general.confirmDeletes !== false && !(await confirmDialog(`Remove ${n} photo${n > 1 ? 's' : ''} from the catalog?`, 'The original files stay on disk untouched. Only the catalog entries, their edits and previews are removed.', { okLabel: 'Remove', danger: true }))) return;
  await api.removePhotos(ids);
  await useLibrary.getState().refresh();
  await useLibrary.getState().refreshMeta();
  app.toast({ kind: 'success', title: `Removed ${n} photo${n > 1 ? 's' : ''} from the catalog`, body: 'Original files were not modified.' });
}

export function photoMenu(p: Photo): MenuItem[] {
  const lib = useLibrary.getState();
  const ids = lib.targetIds();
  const many = ids.length > 1;
  const clip = useDevelop.getState().clipboard;
  const collections = lib.collections.filter(c => c.kind !== 'smart');
  return [
    { label: 'Edit in Develop', icon: <SlidersHorizontal size={14} />, onClick: () => { lib.setActive(p.id); goWorkspace('develop'); } },
    { sep: true },
    { label: p.flag === 'pick' ? 'Remove Pick Flag' : 'Flag as Pick', icon: <Flag size={14} />, shortcut: 'P', onClick: () => setFlag(p.flag === 'pick' ? 'none' : 'pick', ids) },
    { label: p.flag === 'reject' ? 'Remove Reject Flag' : 'Reject', icon: <X size={14} />, shortcut: 'X', onClick: () => setFlag(p.flag === 'reject' ? 'none' : 'reject', ids) },
    { label: p.favorite ? 'Remove from Favorites' : 'Add to Favorites', icon: <Heart size={14} />, onClick: () => toggleFavorite(ids) },
    { label: 'Rate 5 Stars', shortcut: '5', onClick: () => setRating(5, ids) },
    { label: 'Clear Rating', shortcut: '0', onClick: () => setRating(0, ids) },
    { sep: true },
    { label: 'Copy Settings', icon: <Copy size={14} />, disabled: many, onClick: async () => {
      const dev = useDevelop.getState();
      if (dev.photoId !== p.id) { await dev.load(p); }
      useDevelop.getState().copySettings();
      useApp.getState().toast({ kind: 'info', title: 'Settings copied', body: `From ${p.filename}` });
    } },
    { label: `Paste Settings${many ? ` to ${ids.length} Photos` : ''}`, icon: <ClipboardPaste size={14} />, disabled: !clip, onClick: async () => {
      const n = await useDevelop.getState().pasteSettings(ids);
      useApp.getState().toast({ kind: 'success', title: `Settings pasted to ${n} photo${n > 1 ? 's' : ''}` });
    } },
    { label: 'Create Virtual Copy', icon: <Layers size={14} />, disabled: many, onClick: () => { lib.setActive(p.id); createVirtualCopy(); } },
    ...(collections.length ? [{ sep: true } as MenuItem, ...collections.slice(0, 8).map(c => ({ label: `Add to “${c.name}”`, icon: <FolderPlus size={14} />, onClick: async () => { await api.addToCollection(c.id, ids); lib.refreshMeta(); useApp.getState().toast({ kind: 'success', title: `Added to ${c.name}` }); } }))] : []),
    { sep: true },
    { label: 'Show in Folder', icon: <FolderOpen size={14} />, disabled: many, onClick: () => api.reveal(p.id) },
    ...(p.thumbState === 'error' ? [{ label: 'Retry Preview', icon: <RotateCw size={14} />, onClick: async () => { const np = await api.retryPreview(p.id); if (np) lib.replacePhoto(np); } }] : []),
    ...(p.aiEnhanced ? [{ label: 'AI enhanced', icon: <Sparkles size={14} />, disabled: true }] : []),
    { label: `Remove from Catalog${many ? ` (${ids.length})` : ''}`, icon: <Trash2 size={14} />, danger: true, onClick: () => removeFromCatalog(ids) },
  ];
}
