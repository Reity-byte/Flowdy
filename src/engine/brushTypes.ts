// src/engine/brushTypes.ts
export type EditorTool = "brush" | "eraser" | "select" | "blur" | "smudge" | "fill" | "ruler" | "transform";
export type BrushStyle = "round" | "pen" | "marker" | "textured" | "blur" | "smudge";

export type BrushSettings = {
  size: number;
  hardness: number;
  opacity: number;
  color: string;
  isEraser: boolean;
  intensity: number;
  startTaper: number;
  endTaper: number;
  colorMix: number;
  brushStyle: BrushStyle; // NOVÉ
  /** When true, painting is clipped to the active layer's existing alpha (ibis Paint/Photoshop "Alpha Lock" / "Lock Transparent Pixels"). */
  alphaLocked: boolean;
  /** Smudge tool only: how strongly each dab drags/deposits the carried patch. Unused by every other brush style. */
  smudgeStrength: number;
};

export type Point = { x: number; y: number };

export type PointerBrushSample = {
  x: number;
  y: number;
  t: number;
  pressure: number;
  pointerType: string;
};