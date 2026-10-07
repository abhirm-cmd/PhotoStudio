import React, { useState } from 'react';
import { Images, Clock, Flag, Heart, SlidersHorizontal, XCircle, AlertTriangle, Folder, FolderOpen, ChevronRight, ChevronDown, Plus, Wand2, Album, Library as LibIcon, Tag, Trash2, Pencil } from 'lucide-react';
import { useLibrary, type Source } from '../store/library';
import { useApp } from '../store/app';
import { Section, openMenu, promptText, confirmDialog } from '../components/ui';
import { api } from '../api';
import type { FolderNode, Collection } from '@shared/types';

const same = (a: Source, b: Source) => JSON.stringify(a) === JSON.stringify(b);

function NavItem({ icon, name, count, source, onContext }: { icon: React.ReactNode; name: string; count?: number; source: Source; onContext?: (e: React.MouseEvent) => void }) {
  const cur = useLibrary(s => s.source);
  const setSource = useLibrary(s => s.setSource);
  const active = same(cur, source);
  return (
    <div className={`nav-item${active ? ' active' : ''}`} onClick={() => setSource(source)} onContextMenu={onContext} role="button" tabIndex={0} aria-pressed={active}
      onKeyDown={e => { if (e.key === 'Enter') setSource(source); }}
      onDragOver={e => { if (source.kind === 'collection' && e.dataTransfer.types.includes('application/x-lumora-photos')) { e.preventDefault(); (e.currentTarget as HTMLElement).classList.add('drop'); } }}
      onDragLeave={e => (e.currentTarget as HTMLElement).classList.remove('drop')}
      onDrop={async e => {
        (e.currentTarget as HTMLElement).classList.remove('drop');
        if (source.kind !== 'collection') return;
        const ids = JSON.parse(e.dataTransfer.getData('application/x-lumora-photos') || '[]');
        if (!ids.length) return;
        await api.addToCollection(source.id, ids);
        useLibrary.getState().refreshMeta();
        useApp.getState().toast({ kind: 'success', title: `Added ${ids.length} photo${ids.length > 1 ? 's' : ''} to ${name}` });
      }}>
      {icon}<span className="name">{name}</span>{count != null && <span className="count">{count}</span>}
    </div>
  );
}

function FolderTree({ nodes, depth }: { nodes: FolderNode[]; depth: number }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  return (
    <>
      {nodes.map(n => {
        const isOpen = open[n.path] ?? depth < 1;
        return (
          <React.Fragment key={n.path}>
            <div className="folder-row">
              {Array.from({ length: depth }, (_, i) => <span key={i} className="tree-indent" />)}
              {n.children.length ? (
                <button className="tree-toggle" onClick={() => setOpen(o => ({ ...o, [n.path]: !isOpen }))} aria-label={isOpen ? 'Collapse' : 'Expand'}>{isOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}</button>
              ) : <span className="tree-toggle" />}
              <NavItem icon={isOpen && n.children.length ? <FolderOpen size={14} /> : <Folder size={14} />} name={n.name} count={n.count} source={{ kind: 'folder', path: n.path }}
                onContext={e => openMenu(e, [{ label: 'Show in File Manager', onClick: () => api.revealPath(n.path) }, { label: 'Import New Photos From Folder…', onClick: () => useApp.getState().openModal('import', { paths: [n.path] }) }])} />
            </div>
            {isOpen && n.children.length > 0 && <FolderTree nodes={n.children} depth={depth + 1} />}
          </React.Fragment>
        );
      })}
    </>
  );
}

function collectionMenu(c: Collection) {
  const lib = useLibrary.getState();
  return [
    { label: 'Rename…', icon: <Pencil size={14} />, onClick: async () => { const name = await promptText('Rename collection', c.name); if (name) { await api.updateCollection(c.id, { name }); lib.refreshMeta(); } } },
    ...(c.kind === 'smart' ? [{ label: 'Edit Rules…', icon: <Wand2 size={14} />, onClick: () => useApp.getState().openModal('smartCollection', { collection: c }) }] : []),
    { sep: true },
    { label: 'Delete Collection', icon: <Trash2 size={14} />, danger: true, onClick: async () => {
      if (!(await confirmDialog(`Delete “${c.name}”?`, 'The photos stay in your catalog.', { okLabel: 'Delete', danger: true }))) return;
      await api.deleteCollection(c.id);
      if (lib.source.kind === 'collection' && lib.source.id === c.id) lib.setSource({ kind: 'all' });
      lib.refreshMeta();
    } },
  ];
}

export function LibraryNav() {
  const stats = useLibrary(s => s.stats);
  const folders = useLibrary(s => s.folders);
  const collections = useLibrary(s => s.collections);
  const keywords = useLibrary(s => s.distinct.keywords);
  const setFilter = useLibrary(s => s.setFilter);
  const kw = useLibrary(s => s.filter.keyword);
  const open = useApp(s => s.openModal);

  const newCollection = async (kind: 'collection' | 'album') => {
    const name = await promptText(kind === 'album' ? 'New album' : 'New collection', '', { label: 'Name', okLabel: 'Create' });
    if (!name) return;
    const id = await api.createCollection(name, kind);
    const ids = useLibrary.getState().selection;
    if (ids.length > 1) await api.addToCollection(id, ids);
    await useLibrary.getState().refreshMeta();
  };

  return (
    <>
      <Section id="lib.catalog" title="Catalog">
        <div className="nav-list">
          <NavItem icon={<Images size={14} />} name="All Photos" count={stats?.photos} source={{ kind: 'all' }} />
          <NavItem icon={<Clock size={14} />} name="Recently Imported" source={{ kind: 'recent' }} />
          <NavItem icon={<Flag size={14} />} name="Picks" count={stats?.picks} source={{ kind: 'picks' }} />
          <NavItem icon={<Heart size={14} />} name="Favorites" source={{ kind: 'favorites' }} />
          <NavItem icon={<SlidersHorizontal size={14} />} name="Edited" count={stats?.edited} source={{ kind: 'edited' }} />
          <NavItem icon={<XCircle size={14} />} name="Rejected" count={stats?.rejects} source={{ kind: 'rejects' }} />
          <NavItem icon={<AlertTriangle size={14} />} name="Needs Attention" source={{ kind: 'errors' }} />
        </div>
      </Section>
      <Section id="lib.folders" title="Folders" actions={<button className="icon-btn sm" title="Import folder" onClick={() => open('import')}><Plus size={13} /></button>}>
        <div className="nav-list">
          {folders.length ? <FolderTree nodes={folders} depth={0} /> : <p className="dim small pad">Folders appear here after you import photos.</p>}
        </div>
      </Section>
      <Section id="lib.collections" title="Collections" actions={
        <button className="icon-btn sm" title="New collection" onClick={e => openMenu(e, [
          { label: 'New Collection…', icon: <LibIcon size={14} />, onClick: () => newCollection('collection') },
          { label: 'New Album…', icon: <Album size={14} />, onClick: () => newCollection('album') },
          { label: 'New Smart Collection…', icon: <Wand2 size={14} />, onClick: () => open('smartCollection') },
        ])}><Plus size={13} /></button>}>
        <div className="nav-list">
          {collections.map(c => (
            <NavItem key={c.id} icon={c.kind === 'smart' ? <Wand2 size={14} /> : c.kind === 'album' ? <Album size={14} /> : <LibIcon size={14} />} name={c.name} count={c.count}
              source={{ kind: 'collection', id: c.id }} onContext={e => openMenu(e, collectionMenu(c))} />
          ))}
          {!collections.length && <p className="dim small pad">Group photos into collections, albums, or rule-based smart collections. Drag photos onto a collection to add them.</p>}
        </div>
      </Section>
      <Section id="lib.keywords" title="Keywords" defaultOpen={false}>
        <div className="chips">
          {keywords.map(k => <button key={k} className={`chip${kw === k ? ' on' : ''}`} onClick={() => setFilter({ keyword: kw === k ? '' : k })}><Tag size={10} />{k}</button>)}
          {!keywords.length && <p className="dim small">No keywords yet. Add them in the Metadata panel.</p>}
        </div>
      </Section>
    </>
  );
}
