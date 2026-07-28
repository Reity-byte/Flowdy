import { create } from "zustand";
import type { EditorTool, BrushStyle } from "../engine/brushTypes";
import type { RulerType } from "../engine/RulerManager";
import type { TransformMode } from "../engine/TransformManager";

export const BRUSH_PRESETS = {
  "fade-watercolor": { name: "Fade Watercolor (Mix)", style: "round" as BrushStyle, size: 50, hardness: 0.1, opacity: 0.8, intensity: 0.3, startTaper: 150, endTaper: 150, colorMix: 0.8, smudgeStrength: 0 },
  "blurring-marker": { name: "Blurring Marker 1", style: "marker" as BrushStyle, size: 50, hardness: 0.3, opacity: 0.9, intensity: 0.6, startTaper: 80, endTaper: 80, colorMix: 0.4, smudgeStrength: 0 },
  "round-brush": { name: "Round Brush (Rough)", style: "round" as BrushStyle, size: 50, hardness: 0.7, opacity: 1, intensity: 0.8, startTaper: 40, endTaper: 40, colorMix: 0.1, smudgeStrength: 0 },
  "felt-tip": { name: "Felt Tip Pen (Soft)", style: "pen" as BrushStyle, size: 58, hardness: 1, opacity: 1, intensity: 1, startTaper: 0, endTaper: 0, colorMix: 0, smudgeStrength: 0 },
  "textured-bristle": { name: "Textured Bristle", style: "textured" as BrushStyle, size: 55, hardness: 0.6, opacity: 1, intensity: 0.9, startTaper: 30, endTaper: 30, colorMix: 0, smudgeStrength: 0 },
};

export type PresetId = keyof typeof BRUSH_PRESETS;

type ToolSettings = {
  activePresetId: PresetId | null;
  brushStyle: BrushStyle;
  brushSize: number;
  brushHardness: number;
  brushOpacity: number;
  intensity: number;
  startTaper: number;
  endTaper: number;
  colorMix: number;
  smudgeStrength: number;
};

export type SelectMode = "rect" | "lasso";

type EditorState = ToolSettings & {
  tool: EditorTool;
  color: string;
  brushMemory: ToolSettings;
  eraserMemory: ToolSettings;
  blurMemory: ToolSettings;
  smudgeMemory: ToolSettings;
  /** Sub-mode for the Select tool — rectangle marquee or freehand lasso. */
  selectMode: SelectMode;
  /** Stroke correction strength, 0 (no correction) to 10 (maximum). Unlike
   * most brush apps' real-time smoothing, this drives a POST-stroke
   * recalculation (HighPerformanceBrushStroke averages the recorded raw
   * path once the pointer lifts and redraws the corrected result) rather
   * than a live per-move filter — cheaper while actively drawing, at the
   * cost of the corrected stroke only appearing after release. Deliberately
   * global, not per-tool memory like ToolSettings — it's an input-feel
   * preference, not a paint parameter, so it stays put when switching tools. */
  stabilization: number;

  /** Bucket/fill tool: how close a neighboring pixel's color must be to the
   * clicked seed pixel (0 = exact match only, 100 = fills everything) to be
   * swept into the same contiguous fill region. */
  fillTolerance: number;
  /** Bucket/fill tool: ibis Paint's "reference: all layers" mode. When true,
   * fill boundaries are read from the merged, visible-layers-composited
   * image (so line art on a different layer is respected) instead of just
   * the active layer's own pixels — but the actual color deposit still only
   * ever lands on the active layer, exactly as it does when this is off.
   * Defaults off so existing single-layer fill behavior doesn't silently
   * change underfoot. */
  fillSampleAllLayers: boolean;

  /** Drawing-guide (ruler) shape and whether it's currently constraining
   * strokes — the guide's actual placed geometry lives engine-side in
   * `RulerManager` (per-document interaction state, not app data), mirroring
   * how selection geometry is handled. */
  rulerType: RulerType;
  rulerEnabled: boolean;

  /** Transform tool's active sub-mode and mesh subdivision (X/Y division
   * count for Mesh mode) — reactive UI state the ToolPalette reads/writes,
   * synced into `TransformManager` (the actual point-grid/gesture state)
   * engine-side, same "cheap reactive toggle vs. engine-owned geometry"
   * split as the ruler above. */
  transformMode: TransformMode;
  meshDivisionsX: number;
  meshDivisionsY: number;

  setTool: (t: EditorTool) => void;
  setSelectMode: (m: SelectMode) => void;
  loadPreset: (id: PresetId) => void;
  setBrushSize: (s: number) => void;
  setBrushHardness: (h: number) => void;
  setBrushOpacity: (o: number) => void;
  setColor: (c: string) => void;
  setIntensity: (i: number) => void;
  setStartTaper: (t: number) => void;
  setEndTaper: (t: number) => void;
  setColorMix: (m: number) => void;
  setSmudgeStrength: (s: number) => void;
  setStabilization: (s: number) => void;
  setFillTolerance: (t: number) => void;
  setFillSampleAllLayers: (v: boolean) => void;
  setRulerType: (t: RulerType) => void;
  setRulerEnabled: (e: boolean) => void;
  setTransformMode: (m: TransformMode) => void;
  setMeshDivisions: (x: number, y: number) => void;
};

const defaultBrush: ToolSettings = { activePresetId: "felt-tip", brushStyle: "pen", brushSize: 58, brushHardness: 1, brushOpacity: 1, intensity: 1, startTaper: 0, endTaper: 0, colorMix: 0, smudgeStrength: 0 };
const defaultEraser: ToolSettings = { activePresetId: null, brushStyle: "round", brushSize: 80, brushHardness: 1, brushOpacity: 1, intensity: 1, startTaper: 0, endTaper: 0, colorMix: 0, smudgeStrength: 0 };
const defaultBlur: ToolSettings = { activePresetId: null, brushStyle: "blur", brushSize: 60, brushHardness: 0.6, brushOpacity: 1, intensity: 0.5, startTaper: 0, endTaper: 0, colorMix: 0, smudgeStrength: 0 };
const defaultSmudge: ToolSettings = { activePresetId: null, brushStyle: "smudge", brushSize: 60, brushHardness: 0.7, brushOpacity: 1, intensity: 1, startTaper: 0, endTaper: 0, colorMix: 0, smudgeStrength: 0.6 };

/** Tools that paint on the canvas (as opposed to Select) each keep their own settings memory, restored whenever you switch back to that tool. */
const PAINT_TOOL_MEMORY_KEY: Partial<Record<EditorTool, "brushMemory" | "eraserMemory" | "blurMemory" | "smudgeMemory">> = {
  brush: "brushMemory",
  eraser: "eraserMemory",
  blur: "blurMemory",
  smudge: "smudgeMemory",
};

export const useEditorStore = create<EditorState>((set, get) => ({
  tool: "brush",
  color: "#1a1a1a",
  ...defaultBrush,
  brushMemory: { ...defaultBrush },
  eraserMemory: { ...defaultEraser },
  blurMemory: { ...defaultBlur },
  smudgeMemory: { ...defaultSmudge },
  selectMode: "rect",
  // A middle-of-the-road default — some correction, not maximal.
  stabilization: 4,
  fillTolerance: 20,
  fillSampleAllLayers: false,
  rulerType: "straight",
  rulerEnabled: true,
  transformMode: "translate",
  meshDivisionsX: 2,
  meshDivisionsY: 2,

  setTool: (newTool) => {
    const s = get();
    if (s.tool === newTool) return;

    // Uložíme aktuální stav do paměti — každý malující nástroj (brush/
    // eraser/blur/smudge) si drží vlastní paměť; Select nemaluje, takže ji
    // nepotřebuje.
    const currentSettings: ToolSettings = {
      activePresetId: s.activePresetId, brushStyle: s.brushStyle, brushSize: s.brushSize,
      brushHardness: s.brushHardness, brushOpacity: s.brushOpacity, intensity: s.intensity,
      startTaper: s.startTaper, endTaper: s.endTaper, colorMix: s.colorMix, smudgeStrength: s.smudgeStrength,
    };

    const prevKey = PAINT_TOOL_MEMORY_KEY[s.tool];
    if (prevKey) set({ [prevKey]: currentSettings } as Pick<EditorState, typeof prevKey>);

    // Načtení paměti nového nástroje
    const nextKey = PAINT_TOOL_MEMORY_KEY[newTool];
    const targetMemory = nextKey ? get()[nextKey] : null;

    set({
      tool: newTool,
      ...(targetMemory ? targetMemory : {})
    });
  },

  loadPreset: (id) => {
    const p = BRUSH_PRESETS[id];
    set({
      activePresetId: id, brushStyle: p.style, brushSize: p.size, brushHardness: p.hardness,
      brushOpacity: p.opacity, intensity: p.intensity, startTaper: p.startTaper, endTaper: p.endTaper, colorMix: p.colorMix,
      smudgeStrength: p.smudgeStrength,
    });
  },

  setBrushSize: (brushSize) => set({ brushSize }),
  setBrushHardness: (brushHardness) => set({ brushHardness }),
  setBrushOpacity: (brushOpacity) => set({ brushOpacity }),
  setColor: (color) => set({ color }),
  setIntensity: (intensity) => set({ intensity }),
  setStartTaper: (startTaper) => set({ startTaper }),
  setEndTaper: (endTaper) => set({ endTaper }),
  setColorMix: (colorMix) => set({ colorMix }),
  setSelectMode: (selectMode) => set({ selectMode }),
  setSmudgeStrength: (smudgeStrength) => set({ smudgeStrength }),
  setStabilization: (stabilization) => set({ stabilization }),
  setFillTolerance: (fillTolerance) => set({ fillTolerance }),
  setFillSampleAllLayers: (fillSampleAllLayers) => set({ fillSampleAllLayers }),
  setRulerType: (rulerType) => set({ rulerType }),
  setRulerEnabled: (rulerEnabled) => set({ rulerEnabled }),
  setTransformMode: (transformMode) => set({ transformMode }),
  setMeshDivisions: (meshDivisionsX, meshDivisionsY) => set({ meshDivisionsX, meshDivisionsY }),
}));
