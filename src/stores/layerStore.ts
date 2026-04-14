import { create } from "zustand";
import { ARTBOARD_HEIGHT, ARTBOARD_WIDTH } from "../engine/artboardConfig";
import { nanoid } from "../lib/nanoid";

export type LayerMeta = {
  id: string;
  name: string;
  visible: boolean;
};

const BYTES_PER_PIXEL = 4;

/** Default cap for summed RGBA layer surfaces (documentCanvas must stay in sync). */
export const DEFAULT_LAYER_RAM_BUDGET_MB = 512;

export function layerSurfaceBytes(
  width = ARTBOARD_WIDTH,
  height = ARTBOARD_HEIGHT,
): number {
  return width * height * BYTES_PER_PIXEL;
}

export function maxLayersForBudget(
  budgetMb: number,
  width = ARTBOARD_WIDTH,
  height = ARTBOARD_HEIGHT,
): number {
  const per = layerSurfaceBytes(width, height);
  if (per <= 0) return 0;
  return Math.max(1, Math.floor((budgetMb * 1024 * 1024) / per));
}

type LayerState = {
  layers: LayerMeta[];
  activeLayerId: string | null;
  /** Soft RAM budget for all full-size layer bitmaps (RGBA). */
  memoryBudgetMb: number;
  setMemoryBudgetMb: (mb: number) => void;
  /** Sum of estimated backing store bytes at current artboard size × layer count. */
  getEstimatedMemoryBytes: () => number;
  /** Whether another layer fits under `memoryBudgetMb`. */
  canAddLayer: () => boolean;
  addLayer: () => boolean;
  deleteLayer: (id: string) => void;
  renameLayer: (id: string, name: string) => void;
  setActiveLayer: (id: string) => void;
  toggleVisible: (id: string) => void;
  moveLayer: (id: string, direction: "up" | "down") => void;
};

const defaultName = (index: number) => `Layer ${index + 1}`;

const seedId = nanoid();

export const useLayerStore = create<LayerState>((set, get) => ({
  layers: [{ id: seedId, name: defaultName(0), visible: true }],
  activeLayerId: seedId,
  memoryBudgetMb: DEFAULT_LAYER_RAM_BUDGET_MB,

  setMemoryBudgetMb: (memoryBudgetMb) =>
    set({ memoryBudgetMb: Math.max(32, memoryBudgetMb) }),

  getEstimatedMemoryBytes: () => {
    const { layers } = get();
    return layers.length * layerSurfaceBytes();
  },

  canAddLayer: () => {
    const s = get();
    const nextBytes = (s.layers.length + 1) * layerSurfaceBytes();
    return nextBytes <= s.memoryBudgetMb * 1024 * 1024;
  },

  addLayer: () => {
    if (!get().canAddLayer()) return false;
    const id = nanoid();
    set((s) => {
      // Compute a next default name by scanning existing Layer N names
      let maxN = 0;
      for (const l of s.layers) {
        const m = l.name.match(/^Layer\s+(\d+)$/);
        if (m) {
          const n = Number(m[1]);
          if (n > maxN) maxN = n;
        }
      }
      const nextIdx = maxN + 1 || s.layers.length + 1;
      const next: LayerMeta = {
        id,
        name: defaultName(nextIdx - 1),
        visible: true,
      };
      return {
        layers: [...s.layers, next],
        activeLayerId: id,
      };
    });
    return true;
  },

  deleteLayer: (id) => {
    set((s) => {
      const layers = s.layers.filter((l) => l.id !== id);
      const activeLayerId =
        s.activeLayerId === id
          ? layers[layers.length - 1]?.id ?? null
          : s.activeLayerId;
      return { layers, activeLayerId };
    });
  },

  renameLayer: (id: string, name: string) => {
    set((s) => ({
      layers: s.layers.map((l) => (l.id === id ? { ...l, name } : l)),
    }));
  },

  setActiveLayer: (id) => set({ activeLayerId: id }),

  toggleVisible: (id) => {
    set((s) => ({
      layers: s.layers.map((l) =>
        l.id === id ? { ...l, visible: !l.visible } : l,
      ),
    }));
  },

  moveLayer: (id, direction) => {
    set((s) => {
      const idx = s.layers.findIndex((l) => l.id === id);
      if (idx < 0) return s;
      const swap = direction === "up" ? idx + 1 : idx - 1;
      if (swap < 0 || swap >= s.layers.length) return s;
      const copy = [...s.layers];
      const tmp = copy[idx]!;
      copy[idx] = copy[swap]!;
      copy[swap] = tmp;
      return { layers: copy };
    });
  },
}));
