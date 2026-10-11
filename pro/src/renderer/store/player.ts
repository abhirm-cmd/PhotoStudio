import { create } from 'zustand';

interface PlayerState {
  /** Program (timeline) playhead, frames */
  frame: number;
  playing: boolean;
  /** Shuttle rate: 1, 2, 4, -1, -2, -4 … */
  rate: number;
  loop: boolean;
  setFrame(f: number): void;
  play(rate?: number): void;
  pause(): void;
  setLoop(v: boolean): void;

  /** Source monitor */
  sourceId: string | null;
  sourceTime: number;
  sourcePlaying: boolean;
  sourceIn: number | null;
  sourceOut: number | null;
  setSource(id: string | null): void;
}

export const usePlayer = create<PlayerState>((set) => ({
  frame: 0,
  playing: false,
  rate: 1,
  loop: false,
  setFrame: f => set({ frame: Math.max(0, Math.round(f)) }),
  play: (rate = 1) => set({ playing: true, rate }),
  pause: () => set({ playing: false, rate: 1 }),
  setLoop: loop => set({ loop }),

  sourceId: null,
  sourceTime: 0,
  sourcePlaying: false,
  sourceIn: null,
  sourceOut: null,
  setSource: sourceId => set({ sourceId, sourceTime: 0, sourceIn: null, sourceOut: null, sourcePlaying: false }),
}));
