import { useState, useRef, useEffect } from "react";
import { useAppStore } from "../stores/appStore";
import { useEditorStore, BRUSH_PRESETS, PresetId } from "../stores/editorStore";

export function TopBar() {
  const openGallery = useAppStore((s) => s.openGallery);
  const tool = useEditorStore((s) => s.tool);
  const setTool = useEditorStore((s) => s.setTool);
  const activePresetId = useEditorStore((s) => s.activePresetId);
  const loadPreset = useEditorStore((s) => s.loadPreset);

  const [isBrushMenuOpen, setIsBrushMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsBrushMenuOpen(false);
      }
    };
    if (isBrushMenuOpen) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isBrushMenuOpen]);

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-shell-border bg-shell-panel px-4 relative">
      <div className="flex items-center gap-4">
         <button onClick={openGallery} className="text-sm font-semibold text-shell-text opacity-80 hover:opacity-100 transition">← Gallery</button>
         <h1 className="font-bold text-shell-text text-lg">Flowdy</h1>
      </div>

      <div className="flex items-center gap-2 bg-shell-bg p-1 rounded-lg border border-shell-border">
         <button onClick={() => setTool("brush")} className={`px-4 py-1 text-sm rounded-md transition ${tool === "brush" ? "bg-shell-accent text-white" : "text-shell-text opacity-70 hover:opacity-100"}`}>Brush</button>
         <button onClick={() => setTool("eraser")} className={`px-4 py-1 text-sm rounded-md transition ${tool === "eraser" ? "bg-shell-accent text-white" : "text-shell-text opacity-70 hover:opacity-100"}`}>Eraser</button>
         
         <div className="w-px h-5 bg-shell-border mx-1"></div>
         
         <div className="relative" ref={menuRef}>
           <button 
             onClick={() => setIsBrushMenuOpen(!isBrushMenuOpen)}
             className="flex items-center gap-2 px-3 py-1 text-sm font-medium text-shell-text opacity-80 hover:opacity-100 rounded hover:bg-shell-border/50 transition"
           >
             {BRUSH_PRESETS[activePresetId].name}
             <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 9 6 6 6-6"/></svg>
           </button>

           {isBrushMenuOpen && (
             <div className="absolute top-full left-0 mt-2 w-80 bg-shell-panel border border-shell-border rounded-xl shadow-2xl overflow-hidden z-50 flex flex-col">
                {(Object.entries(BRUSH_PRESETS) as [PresetId, typeof BRUSH_PRESETS[PresetId]][]).map(([id, preset]) => (
                  <button
                    key={id}
                    onClick={() => { loadPreset(id); setIsBrushMenuOpen(false); setTool("brush"); }}
                    className={`flex flex-col gap-1 p-3 text-left transition border-b border-shell-border last:border-0 hover:bg-shell-bg ${activePresetId === id ? 'bg-shell-bg' : ''}`}
                  >
                    <div className="w-full h-12 flex items-center justify-center overflow-hidden px-2 mb-1">
                       {id === "fade-watercolor" && <div className="w-full h-6 rounded-full bg-gradient-to-r from-transparent via-shell-text to-transparent blur-[2px] opacity-50"></div>}
                       {id === "blurring-marker" && <div className="w-full h-4 bg-gradient-to-r from-transparent via-shell-text to-transparent opacity-60"></div>}
                       {id === "round-brush" && <div className="w-full h-5 rounded-full bg-gradient-to-r from-transparent via-shell-text to-transparent blur-[1px] opacity-80"></div>}
                       {id === "felt-tip" && <div className="w-full h-8 rounded-full bg-shell-text"></div>}
                    </div>
                    <div className="flex justify-between items-center w-full px-1">
                      <span className="text-sm font-bold text-shell-text">{preset.name}</span>
                      <span className="text-sm font-mono text-shell-text opacity-50">{preset.size}.0</span>
                    </div>
                  </button>
                ))}
             </div>
           )}
         </div>
      </div>

      <div className="flex items-center gap-2">
         <button onClick={() => useAppStore.getState().saveCurrentProject()} className="text-sm px-3 py-1 bg-shell-bg border border-shell-border text-shell-text rounded hover:brightness-95 transition">Save to Gallery</button>
         <button className="text-sm px-3 py-1 bg-shell-accent text-white rounded hover:brightness-110 transition">Export PNG</button>
      </div>
    </header>
  )
}