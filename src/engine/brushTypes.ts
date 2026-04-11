// src/engine/brushTypes.ts
export type EditorTool = "brush" | "eraser";
export type BrushStyle = "round" | "pen" | "marker";

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
};

export type Point = { x: number; y: number };

export type PointerBrushSample = {
  x: number;
  y: number;
  t: number;
  pressure: number;
  pointerType: string;
};