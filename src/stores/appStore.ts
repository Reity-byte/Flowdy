// src/stores/appStore.ts
import { create } from "zustand";
import { isTauri } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { saveProject, loadProject, loadAllProjects, updateProjectName, deleteProject, type Project } from "../lib/db";
import { useLayerStore } from "./layerStore";
import { useHistoryStore, type DocumentSnapshot } from "./historyStore";
import { documentEngineRef } from "../engine/documentEngineRef";

type AppState = {
  currentScreen: "gallery" | "editor";
  isNewCanvasPopupOpen: boolean;
  currentProjectId: string | null;
  savedProjects: Project[];
  pendingLoadSnapshot: DocumentSnapshot | null;
  canvasWidth: number;
  canvasHeight: number;
  /** Whether the editor has pixel/layer changes since the last save. */
  isDirty: boolean;

  // Stavy pro notifikace a export
  notification: string | null;
  isExportModalOpen: boolean;

  showNotification: (msg: string) => void;
  toggleExportModal: (isOpen: boolean) => void;

  deleteProject: (id: string) => Promise<void>;
  toggleNewCanvasPopup: (isOpen: boolean) => void;
  markDirty: () => void;
  /** Switches to the gallery, prompting for confirmation first if there are unsaved changes. */
  openGallery: () => Promise<void>;
  openEditor: (projectId?: string, w?: number, h?: number) => Promise<void>;
  saveCurrentProject: () => Promise<void>;
  fetchProjects: () => Promise<void>;
  renameProject: (id: string, newName: string) => Promise<void>;
};

let notificationTimer: ReturnType<typeof setTimeout> | null = null;
const NOTIFICATION_DURATION_MS = 2000;

export const useAppStore = create<AppState>((set, get) => ({
  currentScreen: "gallery",
  isNewCanvasPopupOpen: false,
  currentProjectId: null,
  savedProjects: [],
  pendingLoadSnapshot: null,
  canvasWidth: 2048,
  canvasHeight: 2048,
  isDirty: false,

  notification: null,
  isExportModalOpen: false,

  toggleExportModal: (isOpen) => set({ isExportModalOpen: isOpen }),

  markDirty: () => set({ isDirty: true }),

  showNotification: (msg) => {
    if (notificationTimer !== null) clearTimeout(notificationTimer);
    set({ notification: msg });
    notificationTimer = setTimeout(() => {
      notificationTimer = null;
      set({ notification: null });
    }, NOTIFICATION_DURATION_MS);
  },
  
  toggleNewCanvasPopup: (isOpen) => set({ isNewCanvasPopupOpen: isOpen }),
  
  openGallery: async () => {
    if (get().isDirty) {
      const msg = "You have unsaved changes. Leave without saving?";
      const confirmed = isTauri()
        ? await ask(msg, { title: "Unsaved changes", kind: "warning" })
        : window.confirm(msg);
      if (!confirmed) return;
    }
    set({ currentScreen: "gallery", isNewCanvasPopupOpen: false, isDirty: false });
  },

  openEditor: async (projectId, w = 2048, h = 2048) => {
     set({ isNewCanvasPopupOpen: false });
    if (projectId) {
      const proj = await loadProject(projectId);
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
          canvasHeight: proj.height || 2048,
          isDirty: false,
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
        canvasHeight: h,
        isDirty: false,
      });
    }
  },

  saveCurrentProject: async () => {
    const state = get();
    const dc = documentEngineRef.current;
    if (!state.currentProjectId || !dc) return;

    dc.commitActiveSelection();

    const layers = useLayerStore.getState().layers;
    const snapshot = dc.captureSnapshot();
    const previewUrl = dc.compositeToDataURL();

    // Preserve a name the user already set via the gallery's rename action —
    // only fall back to the generated default for a project saved for the
    // first time.
    const existing = state.savedProjects.find((p) => p.id === state.currentProjectId);
    const name = existing?.name ?? "Artwork " + state.currentProjectId.slice(-4);

    await saveProject({
      id: state.currentProjectId,
      name,
      previewUrl,
      layers,
      snapshot,
      width: state.canvasWidth,
      height: state.canvasHeight
    });

    set({ isDirty: false });
    get().showNotification("Artwork Saved ✅");
    await state.fetchProjects();
  },

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