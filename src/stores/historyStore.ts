import { create } from "zustand";

/** Per-layer pixel snapshot for undo/redo (MVP: raster only). */
export type LayerPixelSnapshot = {
  id: string;
  data: ImageData;
};

export type DocumentSnapshot = LayerPixelSnapshot[];

type HistoryState = {
  past: DocumentSnapshot[];
  future: DocumentSnapshot[];
  maxDepth: number;
  pushCommittedState: (snap: DocumentSnapshot) => void;
  undo: () => DocumentSnapshot | null;
  redo: () => DocumentSnapshot | null;
  clear: (initial: DocumentSnapshot) => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
};

export const useHistoryStore = create<HistoryState>((set, get) => ({
  past: [],
  future: [],
  maxDepth: 48,

  pushCommittedState: (snap) => {
    set((s) => {
      const past = [...s.past, snap];
      const trimmed =
        past.length > s.maxDepth ? past.slice(past.length - s.maxDepth) : past;
      return { past: trimmed, future: [] };
    });
  },

  undo: () => {
    const { past, future } = get();
    if (past.length <= 1) return null;
    const nextPast = past.slice(0, -1);
    const current = past[past.length - 1]!;
    set({
      past: nextPast,
      future: [...future, current],
    });
    return nextPast[nextPast.length - 1] ?? null;
  },

  redo: () => {
    const { past, future } = get();
    if (future.length === 0) return null;
    const top = future[future.length - 1]!;
    set({
      past: [...past, top],
      future: future.slice(0, -1),
    });
    return top;
  },

  clear: (initial) => set({ past: [initial], future: [] }),

  canUndo: () => get().past.length > 1,
  canRedo: () => get().future.length > 0,
}));
