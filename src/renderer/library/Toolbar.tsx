import React, { useEffect, useState } from 'react';
import { Search, LayoutGrid, Square, Columns2, Grid2x2, Filter, X, ArrowDownWideNarrow, ArrowUpNarrowWide, Sparkles, Star, Flag } from 'lucide-react';
import { useLibrary, emptyFilter } from '../store/library';
import { Seg, LABEL_COLORS, useDebounced } from '../components/ui';
import { goWorkspace } from '../services/actions';
import { looksNatural } from '@shared/nlsearch';
import type { ColorLabel } from '@shared/types';

export function LibraryToolbar({ showFilters, setShowFilters }: { showFilters: boolean; setShowFilters(v: boolean): void }) {
  const view = useLibrary(s => s.view);
  const setView = useLibrary(s => s.setView);
  const sort = useLibrary(s => s.sort);
  const sortDir = useLibrary(s => s.sortDir);
  const setSort = useLibrary(s => s.setSort);
  const size = useLibrary(s => s.thumbSize);
  const setSize = useLibrary(s => s.setThumbSize);
  const search = useLibrary(s => s.search);
  const setSearch = useLibrary(s => s.setSearch);
  const chips = useLibrary(s => s.searchChips);
  const filter = useLibrary(s => s.filter);
  const [text, setText] = useState(search);
  const debounced = useDebounced(text, 220);
  useEffect(() => { if (debounced !== useLibrary.getState().search) setSearch(debounced); }, [debounced]);
  useEffect(() => { setText(search); }, [search]);
  const active = JSON.stringify(filter) !== JSON.stringify(emptyFilter());
  const natural = looksNatural(text);

  return (
    <>
      <div className="lib-toolbar">
        <div className={`search${natural ? ' natural' : ''}`}>
          {natural ? <Sparkles size={14} className="accent" /> : <Search size={14} />}
          <input id="library-search" className="input" placeholder="Search photos, or try “5 star portraits shot at 85mm”" value={text} onChange={e => setText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Escape') { setText(''); (e.target as HTMLInputElement).blur(); } e.stopPropagation(); }} aria-label="Search photos" />
          {text && <button className="icon-btn sm" onClick={() => setText('')} aria-label="Clear search"><X size={12} /></button>}
        </div>
        <button className={`btn sm${showFilters || active ? ' active' : ''}`} onClick={() => setShowFilters(!showFilters)} aria-pressed={showFilters}><Filter size={13} />Filters{active && <span className="dot" />}</button>
        <div className="grow" />
        <Seg value={view === 'compare' ? 'grid' : view} onChange={v => setView(v)} options={[
          { value: 'grid', label: <LayoutGrid size={14} />, title: 'Grid (G)' },
          { value: 'loupe', label: <Square size={14} />, title: 'Loupe (E)' },
          { value: 'survey', label: <Grid2x2 size={14} />, title: 'Survey (N)' },
        ]} />
        <button className="icon-btn" title="Compare (Shift+C)" onClick={() => goWorkspace('compare')}><Columns2 size={15} /></button>
        <select className="input sm" value={sort} onChange={e => setSort(e.target.value as any)} aria-label="Sort by">
          <option value="date">Capture time</option>
          <option value="imported">Import time</option>
          <option value="filename">File name</option>
          <option value="rating">Rating</option>
          <option value="edited">Edit time</option>
        </select>
        <button className="icon-btn" onClick={() => setSort(sort, sortDir === 'asc' ? 'desc' : 'asc')} title={sortDir === 'asc' ? 'Ascending' : 'Descending'}>{sortDir === 'asc' ? <ArrowUpNarrowWide size={15} /> : <ArrowDownWideNarrow size={15} />}</button>
        {view === 'grid' && <input type="range" className="range" min={110} max={360} value={size} onChange={e => setSize(+e.target.value)} aria-label="Thumbnail size" title="Thumbnail size" />}
      </div>
      {chips.length > 0 && (
        <div className="nl-chips">
          <Sparkles size={12} className="accent" /><span className="dim small">Understood as</span>
          {chips.map(c => <span key={c} className="chip on">{c}</span>)}
        </div>
      )}
      {showFilters && <FilterBar />}
    </>
  );
}

const LABELS: ColorLabel[] = ['red', 'yellow', 'green', 'blue', 'purple'];

function FilterBar() {
  const f = useLibrary(s => s.filter);
  const set = useLibrary(s => s.setFilter);
  const clear = useLibrary(s => s.clearFilter);
  const d = useLibrary(s => s.distinct);
  return (
    <div className="filter-bar">
      <div className="fgroup">
        <span className="flabel">Rating</span>
        <select className="input sm" value={f.ratingOp} onChange={e => set({ ratingOp: e.target.value as any })} aria-label="Rating comparison">
          <option value="gte">≥</option><option value="is">=</option><option value="lte">≤</option>
        </select>
        <span className="stars filter-stars">
          {[1, 2, 3, 4, 5].map(i => <button key={i} onClick={() => set({ minRating: f.minRating === i ? 0 : i })} aria-label={`${i} stars`}><Star size={13} className={i <= f.minRating ? 'on' : ''} fill={i <= f.minRating ? 'currentColor' : 'none'} /></button>)}
        </span>
      </div>
      <div className="fgroup">
        <span className="flabel">Flag</span>
        <Seg value={f.flag} onChange={v => set({ flag: v })} options={[
          { value: 'any', label: 'All' }, { value: 'pick', label: <Flag size={12} fill="currentColor" />, title: 'Picks' }, { value: 'none', label: 'Unflagged' }, { value: 'notReject', label: 'Hide rejects' }, { value: 'reject', label: <X size={12} />, title: 'Rejected' },
        ]} />
      </div>
      <div className="fgroup">
        <span className="flabel">Label</span>
        {LABELS.map(l => (
          <button key={l} className={`label-dot${f.labels.includes(l) ? ' on' : ''}`} style={{ background: LABEL_COLORS[l] }} aria-label={`${l} label`} aria-pressed={f.labels.includes(l)}
            onClick={() => set({ labels: f.labels.includes(l) ? f.labels.filter(x => x !== l) : [...f.labels, l] })} />
        ))}
      </div>
      <div className="fgroup">
        <span className="flabel">State</span>
        <select className="input sm" value={f.edited} onChange={e => set({ edited: e.target.value as any })} aria-label="Edit state">
          <option value="any">Any</option><option value="edited">Edited</option><option value="unedited">Unedited</option>
        </select>
        <select className="input sm" value={f.type} onChange={e => set({ type: e.target.value as any })} aria-label="File type">
          <option value="any">All types</option><option value="raw">RAW only</option><option value="other">JPEG / other</option>
        </select>
      </div>
      <div className="fgroup">
        <span className="flabel">Camera</span>
        <select className="input sm" value={f.camera} onChange={e => set({ camera: e.target.value })} aria-label="Camera">
          <option value="">Any camera</option>{d.cameras.map(c => <option key={c}>{c}</option>)}
        </select>
        <select className="input sm" value={f.lens} onChange={e => set({ lens: e.target.value })} aria-label="Lens">
          <option value="">Any lens</option>{d.lenses.map(c => <option key={c}>{c}</option>)}
        </select>
      </div>
      <button className="btn sm ghost" onClick={clear}>Reset</button>
    </div>
  );
}
