import { create } from "zustand";
import { ARTBOARD_HEIGHT, ARTBOARD_WIDTH } from "../engine/artboardConfig";
import { nanoid } from "../lib/nanoid";

export type BlendMode =
  | "normal" | "multiply" | "screen" | "overlay" | "add"
  | "darken" | "lighten" | "difference" | "color" | "luminosity";

export type LayerMeta = {
  id: string;
  name: string;
  visible: boolean;
  /** 0-1. Defaults to 1 (opaque) for layers saved before this field existed. */
  opacity?: number;
  /** Defaults to "normal" for layers saved before this field existed. */
  blendMode?: BlendMode;
  /** ibis Paint/Photoshop "Alpha Lock" — clips painting to the layer's existing alpha. */
  alphaLocked?: boolean;
  /** Procreate/Photoshop "Clipping Mask" — clips this layer's rendering to the alpha of the nearest non-clipped layer below it. Defaults to false for layers saved before this field existed. */
  clippedToLayerBelow?: boolean;
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

type LayerState = {
  layers: LayerMeta[];
  activeLayerId: string | null;
  /** Soft RAM budget for all full-size layer bitmaps (RGBA). */
  memoryBudgetMb: number;
  /** Whether another layer fits under `memoryBudgetMb` at the given artboard size. */
  canAddLayer: (width?: number, height?: number) => boolean;
  addLayer: (width?: number, height?: number) => boolean;
  deleteLayer: (id: string) => void;
  renameLayer: (id: string, name: string) => void;
  setActiveLayer: (id: string) => void;
  toggleVisible: (id: string) => void;
  moveLayer: (id: string, direction: "up" | "down") => void;
  setLayerOpacity: (id: string, opacity: number) => void;
  setLayerBlendMode: (id: string, blendMode: BlendMode) => void;
  toggleAlphaLock: (id: string) => void;
  toggleClipping: (id: string) => void;
  /** Inserts a new layer's metadata directly above `id` (same opacity/blend/name+" copy"). Returns the new layer's id, or null if it wouldn't fit under the memory budget. Caller (DocumentCanvas) is responsible for copying the actual pixel data into the new layer's runtime. */
  duplicateLayerMeta: (id: string, width?: number, height?: number) => string | null;
};

const defaultName = (index: number) => `Layer ${index + 1}`;

const seedId = nanoid();

export const useLayerStore = create<LayerState>((set, get) => ({
  layers: [{ id: seedId, name: defaultName(0), visible: true, opacity: 1, blendMode: "normal", alphaLocked: false }],
  activeLayerId: seedId,
  memoryBudgetMb: DEFAULT_LAYER_RAM_BUDGET_MB,

  canAddLayer: (width, height) => {
    const s = get();
    const nextBytes = (s.layers.length + 1) * layerSurfaceBytes(width, height);
    return nextBytes <= s.memoryBudgetMb * 1024 * 1024;
  },

  addLayer: (width, height) => {
    if (!get().canAddLayer(width, height)) return false;
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
      const nextIdx = maxN + 1;
      const next: LayerMeta = {
        id,
        name: defaultName(nextIdx - 1),
        visible: true,
        opacity: 1,
        blendMode: "normal",
        alphaLocked: false,
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

  setLayerOpacity: (id, opacity) => {
    const clamped = Math.min(1, Math.max(0, opacity));
    set((s) => ({
      layers: s.layers.map((l) => (l.id === id ? { ...l, opacity: clamped } : l)),
    }));
  },

  setLayerBlendMode: (id, blendMode) => {
    set((s) => ({
      layers: s.layers.map((l) => (l.id === id ? { ...l, blendMode } : l)),
    }));
  },

  toggleAlphaLock: (id) => {
    set((s) => ({
      layers: s.layers.map((l) =>
        l.id === id ? { ...l, alphaLocked: !l.alphaLocked } : l,
      ),
    }));
  },

  toggleClipping: (id) => {
    set((s) => ({
      layers: s.layers.map((l) =>
        l.id === id ? { ...l, clippedToLayerBelow: !l.clippedToLayerBelow } : l,
      ),
    }));
  },

  duplicateLayerMeta: (id, width, height) => {
    if (!get().canAddLayer(width, height)) return null;
    const source = get().layers.find((l) => l.id === id);
    if (!source) return null;
    const newId = nanoid();
    set((s) => {
      const idx = s.layers.findIndex((l) => l.id === id);
      const copy: LayerMeta = {
        ...source,
        id: newId,
        name: `${source.name} copy`,
      };
      const layers = [...s.layers];
      layers.splice(idx + 1, 0, copy);
      return { layers, activeLayerId: newId };
    });
    return newId;
  },
}));
