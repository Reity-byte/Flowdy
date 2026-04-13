import { useHistoryStore } from "../stores/historyStore";
import { useAppStore } from "../stores/appStore";
import { documentEngineRef } from "../engine/documentEngineRef";

export function TopBar() {
  const undo = useHistoryStore((s) => s.undo);
  const redo = useHistoryStore((s) => s.redo);
  const canUndo = useHistoryStore((s) => s.canUndo());
  const canRedo = useHistoryStore((s) => s.canRedo());

  const saveProject = useAppStore((s) => s.saveCurrentProject);
  const openGallery = useAppStore((s) => s.openGallery);
  const toggleExportModal = useAppStore((s) => s.toggleExportModal);

  const handleUndo = () => {
    const snap = undo();
    if (snap && documentEngineRef.current) {
      documentEngineRef.current.restoreSnapshot(snap);
    }
  };

  const handleRedo = () => {
    const snap = redo();
    if (snap && documentEngineRef.current) {
      documentEngineRef.current.restoreSnapshot(snap);
    }
  };

  return (
    <div className="flex gap-2 p-3 bg-shell-panel border-b border-shell-border items-center justify-between">
      
      {/* LEVÁ ČÁST */}
      <div className="flex gap-2 w-1/3">
        <button onClick={openGallery} className="px-3 py-1.5 rounded-lg hover:bg-shell-bg border border-transparent hover:border-shell-border transition-colors font-medium">
          🖼 Galerie
        </button>
        <button onClick={() => saveProject()} className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors font-medium">
          💾 Save Artwork
        </button>
        <button onClick={() => toggleExportModal(true)} className="px-3 py-1.5 rounded-lg hover:bg-shell-bg border border-transparent hover:border-shell-border transition-colors font-medium">
          ⬇ Export
        </button>
      </div>

      {/* PROSTŘEDNÍ ČÁST */}
      <div className="flex gap-3 items-center justify-center w-1/3">
        <span className="text-sm font-bold uppercase tracking-widest opacity-50">Flowdy</span>
      </div>

      {/* PRAVÁ ČÁST */}
      <div className="flex gap-2 w-1/3 justify-end">
        <button onClick={handleUndo} disabled={!canUndo} className={`px-4 py-1.5 rounded-lg font-medium transition-colors ${!canUndo ? "opacity-30 cursor-not-allowed" : "hover:bg-shell-bg border border-transparent hover:border-shell-border"}`}>
          ↩ Undo
        </button>
        <button onClick={handleRedo} disabled={!canRedo} className={`px-4 py-1.5 rounded-lg font-medium transition-colors ${!canRedo ? "opacity-30 cursor-not-allowed" : "hover:bg-shell-bg border border-transparent hover:border-shell-border"}`}>
          Redo ↪
        </button>
      </div>
    </div>
  );
}