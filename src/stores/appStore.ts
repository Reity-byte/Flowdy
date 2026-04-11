// src/stores/appStore.ts
import { create } from "zustand";
import { saveProject, loadAllProjects, updateProjectName, deleteProject } from "../lib/db";
import { useLayerStore } from "./layerStore";
import { useHistoryStore } from "./historyStore";
import { documentEngineRef } from "../engine/documentEngineRef";

type AppState = {
  currentScreen: "gallery" | "editor";
  isNewCanvasPopupOpen: boolean;
  currentProjectId: string | null;
  savedProjects: any[];
  pendingLoadSnapshot: any | null; 
  canvasWidth: number;
  canvasHeight: number;
  deleteProject: (id: string) => Promise<void>;
  toggleNewCanvasPopup: (isOpen: boolean) => void;
  openGallery: () => void;
  openEditor: (projectId?: string, w?: number, h?: number) => Promise<void>;
  saveCurrentProject: () => Promise<void>;
  fetchProjects: () => Promise<void>;
  renameProject: (id: string, newName: string) => Promise<void>;
};

export const useAppStore = create<AppState>((set, get) => ({
  currentScreen: "gallery",
  isNewCanvasPopupOpen: false,
  currentProjectId: null,
  savedProjects: [],
  pendingLoadSnapshot: null,
  canvasWidth: 2048,
  canvasHeight: 2048,
  
  toggleNewCanvasPopup: (isOpen) => set({ isNewCanvasPopupOpen: isOpen }),
  
  openGallery: () => set({ currentScreen: "gallery", isNewCanvasPopupOpen: false }),

  openEditor: async (projectId, w = 2048, h = 2048) => {
     set({ isNewCanvasPopupOpen: false });
    if (projectId) {
      const all = await loadAllProjects();
      const proj = all.find(p => p.id === projectId);
      if (proj) {
        useLayerStore.setState({ 
          layers: proj.layers, 
          activeLayerId: proj.layers[0]?.id || null
        });
        set({
          currentScreen: "editor",
          currentProjectId: projectId,
          pendingLoadSnapshot: proj.snapshot,
          canvasWidth: proj.width || 2048,
          canvasHeight: proj.height || 2048
        });
      }
    } else {
      const newLayerId = "layer_" + Date.now();
      useLayerStore.setState({
        layers: [{ id: newLayerId, name: "Layer 1", visible: true }],
        activeLayerId: newLayerId
      });
      useHistoryStore.setState({ past: [], future: [] });

      set({
        currentScreen: "editor",
        currentProjectId: `proj_${Date.now()}`,
        pendingLoadSnapshot: null,
        canvasWidth: w,
        canvasHeight: h
      });
    }
  },

  saveCurrentProject: async () => {
    const state = get();
    const dc = documentEngineRef.current;
    if (!state.currentProjectId || !dc) return;

    const layers = useLayerStore.getState().layers;
    const snapshot = dc.captureSnapshot(); 
    const previewUrl = dc.compositeToDataURL(); 

    await saveProject({
      id: state.currentProjectId,
      name: "Artwork " + state.currentProjectId.slice(-4), 
      previewUrl,
      layers,
      snapshot,
      width: state.canvasWidth,
      height: state.canvasHeight
    });

    await state.fetchProjects();
  },
// ... zbytek souboru zůstává stejný (renameProject, deleteProject atd.),

  // OPRAVENO: Vrácena implementace renameProject
  renameProject: async (id: string, newName: string) => {
    await updateProjectName(id, newName);
    await get().fetchProjects(); 
  },

  deleteProject: async (id: string) => {
    await deleteProject(id);
    await get().fetchProjects();
  },

  fetchProjects: async () => {
    const projects = await loadAllProjects();
    set({ savedProjects: projects });
  }
}));