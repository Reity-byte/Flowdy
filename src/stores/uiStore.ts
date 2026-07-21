import { create } from "zustand";

export type LeftOverlay = "brush" | null;
export type RightOverlay = "color" | "layers" | null;

type UIState = {
  leftOverlay: LeftOverlay;
  rightOverlay: RightOverlay;
  toggleLeftOverlay: (panel: Exclude<LeftOverlay, null>) => void;
  toggleRightOverlay: (panel: Exclude<RightOverlay, null>) => void;
  closeOverlays: () => void;
};

/** Which of the on-demand overlay panels (Brush Settings on the left; Color
 * Picker/Layers on the right) is currently open, if any. Separate from
 * `editorStore` (tool/brush *values*) and `appStore` (project/screen state)
 * — this is purely ephemeral UI chrome state, reset-safe, never persisted. */
export const useUIStore = create<UIState>((set, get) => ({
  leftOverlay: null,
  rightOverlay: null,
  toggleLeftOverlay: (panel) => set({ leftOverlay: get().leftOverlay === panel ? null : panel }),
  toggleRightOverlay: (panel) => set({ rightOverlay: get().rightOverlay === panel ? null : panel }),
  closeOverlays: () => set({ leftOverlay: null, rightOverlay: null }),
}));
