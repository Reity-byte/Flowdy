import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { DocumentCanvas } from "../engine/documentCanvas";
import { documentEngineRef } from "../engine/documentEngineRef";
import { useLayerStore } from "../stores/layerStore";
import { useHistoryStore } from "../stores/historyStore";
import { useAppStore } from "../stores/appStore";

export function CanvasStage() {
  const hostRef = useRef<HTMLDivElement>(null);
  // Selection state lives imperatively inside DocumentCanvas/SelectionManager
  // (it's per-frame interaction state, not app data), so it's polled here at
  // rAF rate — cheap boolean check — rather than plumbed through a store.
  const [selectionActive, setSelectionActive] = useState(false);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;

    const dc = new DocumentCanvas(el);
    let cancelled = false;
    // Rebuilding the Pixi display list is only needed when layer identity,
    // order, or visibility actually changes — not on every store update
    // (renaming a layer or switching the active layer also notify subscribers).
    let lastLayerSignature = "";
    // Clipping masks depend on neighboring layers, not just the toggled layer's
    // own metadata, so `clippedToLayerBelow` must be part of the signature too
    // (unlike opacity/blendMode/alphaLocked, which are self-contained and use
    // their own live-update methods instead of a full syncLayers() pass).
    // `folderId` is included too — grouping a layer doesn't move its own
    // sprite, but changes to `layers`' own array order (dragging into/out of
    // a folder always reorders the array to keep members contiguous) are
    // already covered by the join order; folderId itself only matters
    // combined with the folder's *own* visible flag, which is a separate,
    // parallel signature below (folders are a different store slice — a
    // folder's visibility flipping doesn't touch `layers` at all, so it
    // can't be caught by this signature alone).
    const layerSignature = (layers: { id: string; visible: boolean; clippedToLayerBelow?: boolean; folderId?: string | null }[]) =>
      layers.map((l) => l.id + (l.visible ? "1" : "0") + (l.clippedToLayerBelow ? "1" : "0") + (l.folderId ?? "")).join("|");
    let lastFolderSignature = "";
    const folderSignature = (folders: { id: string; visible: boolean }[]) =>
      folders.map((f) => f.id + (f.visible ? "1" : "0")).join("|");

    void dc.init().then(() => {
      // CRITICAL FIX: If user navigated away before init finished, destroy it!
      if (cancelled) {
        dc.destroy();
        return;
      }

      const layers = useLayerStore.getState().layers;
      lastLayerSignature = layerSignature(layers);
      lastFolderSignature = folderSignature(useLayerStore.getState().folders);
      dc.syncLayers(layers);

      const pendingData = useAppStore.getState().pendingLoadSnapshot;
      if (pendingData) {
        dc.restoreSnapshot(pendingData);
        useAppStore.setState({ pendingLoadSnapshot: null });
      }

      useHistoryStore.getState().clear(dc.captureSnapshot());
      dc.onStrokeCommitted = (changedLayerId) => {
        useHistoryStore.getState().pushCommittedState(dc.captureSnapshot(changedLayerId));
        useAppStore.getState().markDirty();
      };
      documentEngineRef.current = dc;
    });

    const unsub = useLayerStore.subscribe((s) => {
      const sig = layerSignature(s.layers);
      const fsig = folderSignature(s.folders);
      if (sig === lastLayerSignature && fsig === lastFolderSignature) return;
      lastLayerSignature = sig;
      lastFolderSignature = fsig;
      documentEngineRef.current?.syncLayers(s.layers);
    });

    let pollRaf = 0;
    let lastActive = false;
    const pollSelection = () => {
      const active = documentEngineRef.current?.isSelectionActive() ?? false;
      if (active !== lastActive) {
        lastActive = active;
        setSelectionActive(active);
      }
      pollRaf = requestAnimationFrame(pollSelection);
    };
    pollRaf = requestAnimationFrame(pollSelection);

    return () => {
      cancelled = true;
      unsub();
      cancelAnimationFrame(pollRaf);
      dc.destroy();
      if (el) el.innerHTML = ""; // Clear the host DOM
      if (documentEngineRef.current === dc) documentEngineRef.current = null;
    };
  }, []);

  return (
    <div
      ref={hostRef}
      // OPRAVA TADY: absolute inset-0 donutí div roztáhnout se po celém rodiči
      className="absolute inset-0 w-full h-full overflow-hidden rounded-md border border-shell-border bg-shell-bg"
    >
      {selectionActive && (
        <button
          type="button"
          onClick={() => documentEngineRef.current?.commitActiveSelection()}
          className="absolute bottom-4 right-4 z-10 flex items-center gap-1.5 rounded-full bg-shell-accent px-5 py-2 font-semibold text-white shadow-lg transition hover:brightness-110"
        >
          <Check size={16} strokeWidth={2.5} /> Done
        </button>
      )}
    </div>
  );
}