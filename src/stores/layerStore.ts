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
  /** Which folder (see `FolderMeta`) this layer is grouped into, if any. Folders are one level deep only — a folder's own members are never themselves folders. Undefined/null means top-level (ungrouped). */
  folderId?: string | null;
  /** Full layer lock — unlike Alpha Lock (which still allows painting over existing opaque pixels), a locked layer rejects every pixel-mutating tool entirely (brush/eraser/blur/smudge/fill/select-cut, plus the white-to-transparent and recolor-by-alpha actions). Layer-management actions (delete/duplicate/merge/reorder from the panel) are still allowed — this matches how Alpha Lock already only constrains *painting*, not panel actions. */
  locked?: boolean;
};

/**
 * A layer-panel folder: purely organizational (no opacity/blend mode of its
 * own — its member layers composite individually with everything below,
 * exactly as if they weren't grouped; only `visible` and `collapsed` affect
 * anything). A folder's on-canvas stacking position is never stored
 * directly — it's wherever its member layers currently sit in `layers`
 * (which must stay CONTIGUOUS: moving a layer into/out of/within a folder
 * always keeps every member of a folder adjacent in `layers`, see
 * `moveLayerTo`). An empty folder (no members yet) has no position to derive
 * this way, so the UI pins it to the top of the stack until it gets a first
 * member.
 */
export type FolderMeta = {
  id: string;
  name: string;
  visible: boolean;
  /** Whether the folder's members are hidden from the layer panel's list (UI-only — never affects canvas rendering). */
  collapsed: boolean;
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
  folders: FolderMeta[];
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
  toggleLayerLock: (id: string) => void;
  /** Creates a new empty folder (shown pinned to the top of the panel until it has a member — see `FolderMeta`'s doc comment). Returns the new folder's id. */
  addFolder: () => string;
  renameFolder: (id: string, name: string) => void;
  toggleFolderVisible: (id: string) => void;
  toggleFolderCollapsed: (id: string) => void;
  /** Removes the folder and un-groups its members back to top-level (ungrouping keeps their current stacking position and all their own pixel content/settings — nothing about the layers themselves is touched, only `folderId`). Never deletes layers. */
  deleteFolder: (id: string) => void;
  /**
   * The one primitive both "drag a layer into/out of a folder" and "reorder
   * a layer" reduce to: removes `layerId` from wherever it currently sits in
   * `layers`, sets its `folderId` to `folderId` (null/undefined = top-
   * level), then re-inserts it immediately before `beforeId` (or at the very
   * top of the stack if `beforeId` is null). Callers (the layer panel's drag
   * logic) are responsible for choosing a `beforeId`/`folderId` pair that
   * keeps every folder's members contiguous — e.g. dropping into folder F
   * should pass F's current topmost member as `beforeId` (or null-into-F if
   * F is empty).
   */
  moveLayerTo: (layerId: string, beforeId: string | null, folderId: string | null) => void;
  /** Reorders an ENTIRE folder's contiguous member span (dragging the folder header itself) to sit immediately before `beforeId` (a top-level layer id, or null for the very top of the stack) — members keep their existing relative order. No-op for an empty folder (nothing to move; the empty-folder-pinned-to-top display convention already handles that). */
  moveFolderTo: (folderId: string, beforeId: string | null) => void;
  /** Inserts a new layer's metadata directly above `id` (same opacity/blend/name+" copy"). Returns the new layer's id, or null if it wouldn't fit under the memory budget. Caller (DocumentCanvas) is responsible for copying the actual pixel data into the new layer's runtime. */
  duplicateLayerMeta: (id: string, width?: number, height?: number) => string | null;
};

const defaultName = (index: number) => `Layer ${index + 1}`;

const seedId = nanoid();

export const useLayerStore = create<LayerState>((set, get) => ({
  layers: [{ id: seedId, name: defaultName(0), visible: true, opacity: 1, blendMode: "normal", alphaLocked: false }],
  folders: [],
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
        locked: false,
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

  toggleLayerLock: (id) => {
    set((s) => ({
      layers: s.layers.map((l) => (l.id === id ? { ...l, locked: !l.locked } : l)),
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

  addFolder: () => {
    const id = nanoid();
    set((s) => {
      let maxN = 0;
      for (const f of s.folders) {
        const m = f.name.match(/^Folder\s+(\d+)$/);
        if (m) {
          const n = Number(m[1]);
          if (n > maxN) maxN = n;
        }
      }
      const next: FolderMeta = { id, name: `Folder ${maxN + 1}`, visible: true, collapsed: false };
      return { folders: [...s.folders, next] };
    });
    return id;
  },

  renameFolder: (id, name) => {
    set((s) => ({
      folders: s.folders.map((f) => (f.id === id ? { ...f, name } : f)),
    }));
  },

  toggleFolderVisible: (id) => {
    set((s) => ({
      folders: s.folders.map((f) => (f.id === id ? { ...f, visible: !f.visible } : f)),
    }));
  },

  toggleFolderCollapsed: (id) => {
    set((s) => ({
      folders: s.folders.map((f) => (f.id === id ? { ...f, collapsed: !f.collapsed } : f)),
    }));
  },

  deleteFolder: (id) => {
    set((s) => ({
      folders: s.folders.filter((f) => f.id !== id),
      // Ungroup, never delete — a layer's own pixels/settings are untouched,
      // only its folder membership is cleared.
      layers: s.layers.map((l) => (l.folderId === id ? { ...l, folderId: null } : l)),
    }));
  },

  moveLayerTo: (layerId, beforeId, folderId) => {
    set((s) => {
      const layer = s.layers.find((l) => l.id === layerId);
      if (!layer) return s;
      const rest = s.layers.filter((l) => l.id !== layerId);
      const updated: LayerMeta = { ...layer, folderId: folderId ?? null };
      let insertAt = rest.length; // default: top of the whole stack
      if (beforeId) {
        const idx = rest.findIndex((l) => l.id === beforeId);
        if (idx >= 0) insertAt = idx;
      }
      const layers = [...rest];
      layers.splice(insertAt, 0, updated);
      return { layers };
    });
  },

  moveFolderTo: (folderId, beforeId) => {
    set((s) => {
      const members = s.layers.filter((l) => l.folderId === folderId);
      if (members.length === 0) return s;
      const memberIds = new Set(members.map((l) => l.id));
      const rest = s.layers.filter((l) => !memberIds.has(l.id));
      let insertAt = rest.length;
      if (beforeId) {
        const idx = rest.findIndex((l) => l.id === beforeId);
        if (idx >= 0) insertAt = idx;
      }
      const layers = [...rest];
      layers.splice(insertAt, 0, ...members);
      return { layers };
    });
  },
}));
