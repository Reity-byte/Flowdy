// src/stores/editorStore.ts
import { create } from "zustand";
import type { EditorTool, BrushStyle } from "../engine/brushTypes";

// Definice našich nových profesionálních štětců
export const BRUSH_PRESETS = {
  "fade-watercolor": { name: "Fade Watercolor (Mix)", style: "round" as BrushStyle, size: 50, hardness: 0.1, opacity: 0.8, intensity: 0.3, startTaper: 150, endTaper: 150, colorMix: 0.8 },
  "blurring-marker": { name: "Blurring Marker 1", style: "marker" as BrushStyle, size: 50, hardness: 0.3, opacity: 0.9, intensity: 0.6, startTaper: 80, endTaper: 80, colorMix: 0.4 },
  "round-brush": { name: "Round Brush (Rough)", style: "round" as BrushStyle, size: 50, hardness: 0.7, opacity: 1, intensity: 0.8, startTaper: 40, endTaper: 40, colorMix: 0.1 },
  "felt-tip": { name: "Felt Tip Pen (Soft)", style: "pen" as BrushStyle, size: 58, hardness: 1, opacity: 1, intensity: 1, startTaper: 0, endTaper: 0, colorMix: 0 },
};

export type PresetId = keyof typeof BRUSH_PRESETS;

type EditorState = {
  tool: EditorTool;
  activePresetId: PresetId;
  brushStyle: BrushStyle;
  brushSize: number;
  brushHardness: number;
  brushOpacity: number;
  color: string;
  
  intensity: number;
  startTaper: number;
  endTaper: number;
  colorMix: number;

  setTool: (t: EditorTool) => void;
  loadPreset: (id: PresetId) => void;
  setBrushSize: (s: number) => void;
  setBrushHardness: (h: number) => void;
  setBrushOpacity: (o: number) => void;
  setColor: (c: string) => void;
  
  setIntensity: (i: number) => void;
  setStartTaper: (t: number) => void;
  setEndTaper: (t: number) => void;
  setColorMix: (m: number) => void;
};

export const useEditorStore = create<EditorState>((set) => ({
  tool: "brush",
  activePresetId: "felt-tip",
  
  // Výchozí hodnoty podle Felt Tip Pen
  brushStyle: "pen",
  brushSize: 58,
  brushHardness: 1,
  brushOpacity: 1,
  color: "#1a1a1a",
  intensity: 1,
  startTaper: 0,
  endTaper: 0,
  colorMix: 0,

  setTool: (tool) => set({ tool }),
  
  // Tato funkce vezme data ze seznamu nahoře a přepíše s nimi slidery
  loadPreset: (id) => {
    const p = BRUSH_PRESETS[id];
    set({
      activePresetId: id,
      brushStyle: p.style,
      brushSize: p.size,
      brushHardness: p.hardness,
      brushOpacity: p.opacity,
      intensity: p.intensity,
      startTaper: p.startTaper,
      endTaper: p.endTaper,
      colorMix: p.colorMix,
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
}));