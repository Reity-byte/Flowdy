import { useState } from "react";
import { useHistoryStore } from "../stores/historyStore";
import { useAppStore } from "../stores/appStore";
import { useEditorStore, BRUSH_PRESETS, PresetId } from "../stores/editorStore";
import { documentEngineRef } from "../engine/documentEngineRef";

export function TopBar() {
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  const undo = useHistoryStore((s) => s.undo);
  const redo = useHistoryStore((s) => s.redo);
  const canUndo = useHistoryStore((s) => s.canUndo());
  const canRedo = useHistoryStore((s) => s.canRedo());

  const saveProject = useAppStore((s) => s.saveCurrentProject);
  const openGallery = useAppStore((s) => s.openGallery);
  const toggleExportModal = useAppStore((s) => s.toggleExportModal);

  const tool = useEditorStore((s) => s.tool);
  const setTool = useEditorStore((s) => s.setTool);
  const loadPreset = useEditorStore((s) => s.loadPreset);
  const activePresetId = useEditorStore((s) => s.activePresetId);

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
    <div className="flex gap-2 p-2 bg-shell-bg border-b border-shell-border items-center justify-between">
      
      {/* LEVÁ ČÁST */}
      <div className="flex gap-2 w-1/3">
        <button onClick={openGallery} className="px-3 py-1 rounded hover:bg-shell-panel transition-colors">
          🖼 Galerie
        </button>
        <button onClick={() => saveProject()} className="px-3 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white transition-colors">
          💾 Save Artwork
        </button>
        <button onClick={() => toggleExportModal(true)} className="px-3 py-1 rounded hover:bg-shell-panel transition-colors">
          ⬇ Export
        </button>
      </div>

      {/* PROSTŘEDNÍ ČÁST (Nástroje a profi menu) */}
      <div className="flex gap-3 items-center justify-center w-1/3 relative">
        <div className="flex gap-1 bg-shell-panel p-1 rounded-lg">
          <button
            onClick={() => setTool("brush")}
            className={`px-4 py-1 rounded transition-colors ${
              tool === "brush" ? "bg-blue-600 text-white shadow" : "hover:bg-shell-bg"
            }`}
          >
            🖌 Brush
          </button>
          <button
            onClick={() => setTool("eraser")}
            className={`px-4 py-1 rounded transition-colors ${
              tool === "eraser" ? "bg-blue-600 text-white shadow" : "hover:bg-shell-bg"
            }`}
          >
            🧹 Eraser
          </button>
        </div>

        {/* Vlastní rozbalovací menu s náhledy */}
        {tool === "brush" && (
          <div className="relative">
            <button
              onClick={() => setIsMenuOpen(!isMenuOpen)}
              className="flex items-center gap-2 bg-shell-bg text-sm text-white px-4 py-1.5 rounded-lg border border-shell-border hover:border-blue-500 transition-colors"
            >
              {activePresetId ? BRUSH_PRESETS[activePresetId as PresetId].name : "Vlastní nastavení..."}
              <span className="text-xs ml-2 opacity-60">▼</span>
            </button>

            {isMenuOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setIsMenuOpen(false)} />
                <div className="absolute top-full left-0 mt-2 w-64 bg-[#1a1a24] border border-shell-border rounded-lg shadow-2xl z-50 overflow-hidden flex flex-col">
                  {Object.entries(BRUSH_PRESETS).map(([id, preset]) => (
                    <button
                      key={id}
                      onClick={() => { loadPreset(id as PresetId); setIsMenuOpen(false); }}
                      className={`flex items-center justify-between px-4 py-3 hover:bg-blue-600/20 transition-colors ${activePresetId === id ? 'bg-blue-600/20 border-l-2 border-blue-500' : 'border-l-2 border-transparent'}`}
                    >
                      <span className="text-sm font-medium">{preset.name}</span>
                      
                      {/* CSS Vizuální náhled štětce */}
                      <div className="flex items-center justify-center w-16 h-6">
                        {id === 'felt-tip' && <div className="w-full h-[2px] bg-white rounded-full opacity-90" />}
                        {id === 'round-brush' && <div className="w-full h-[6px] bg-white rounded-full opacity-80" />}
                        {id === 'blurring-marker' && <div className="w-full h-[10px] bg-white rounded-sm opacity-50" />}
                        {id === 'fade-watercolor' && <div className="w-full h-[14px] bg-gradient-to-r from-transparent via-white to-transparent rounded-full opacity-30" />}
                      </div>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* PRAVÁ ČÁST */}
      <div className="flex gap-2 w-1/3 justify-end">
        <button onClick={handleUndo} disabled={!canUndo} className={`px-3 py-1 rounded transition-colors ${!canUndo ? "opacity-30 cursor-not-allowed" : "hover:bg-shell-panel"}`}>
          ↩ Undo
        </button>
        <button onClick={handleRedo} disabled={!canRedo} className={`px-3 py-1 rounded transition-colors ${!canRedo ? "opacity-30 cursor-not-allowed" : "hover:bg-shell-panel"}`}>
          Redo ↪
        </button>
      </div>

    </div>
  );
}