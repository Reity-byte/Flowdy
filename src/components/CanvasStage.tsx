import { useEffect, useRef } from "react";
import { DocumentCanvas } from "../engine/documentCanvas";
import { documentEngineRef } from "../engine/documentEngineRef";
import { useLayerStore } from "../stores/layerStore";
import { useHistoryStore } from "../stores/historyStore";
import { useAppStore } from "../stores/appStore";

export function CanvasStage() {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;

    const dc = new DocumentCanvas(el);
    let cancelled = false;

    void dc.init().then(() => {
      // CRITICAL FIX: If user navigated away before init finished, destroy it!
      if (cancelled) {
        dc.destroy();
        return;
      }

      dc.syncLayers(useLayerStore.getState().layers);

      const pendingData = useAppStore.getState().pendingLoadSnapshot;
      if (pendingData) {
        dc.restoreSnapshot(pendingData);
        useAppStore.setState({ pendingLoadSnapshot: null }); 
      }

      useHistoryStore.getState().clear(dc.captureSnapshot());
      dc.onStrokeCommitted = () => {
        useHistoryStore.getState().pushCommittedState(dc.captureSnapshot());
      };
      documentEngineRef.current = dc;
    });

    const unsub = useLayerStore.subscribe((s) => {
      documentEngineRef.current?.syncLayers(s.layers);
    });

    return () => {
      cancelled = true;
      unsub();
      dc.destroy();
      if (el) el.innerHTML = ""; // Clear the host DOM
      if (documentEngineRef.current === dc) documentEngineRef.current = null;
    };
  }, []);

  return (
    <div
      ref={hostRef}
      className="relative h-full min-h-0 w-full min-w-0 overflow-hidden rounded-md border border-shell-border bg-shell-bg"
    />
  );
}