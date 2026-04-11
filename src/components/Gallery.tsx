import React, { useEffect, useState } from "react";
import { useAppStore } from "../stores/appStore";

export function Gallery() {
  const openEditor = useAppStore((s) => s.openEditor);
  const savedProjects = useAppStore((s) => s.savedProjects);
  const fetchProjects = useAppStore((s) => s.fetchProjects);
  const toggleNewCanvasPopup = useAppStore((s) => s.toggleNewCanvasPopup);
  
  const [contextMenu, setContextMenu] = useState<{x: number, y: number, id: string, name: string} | null>(null);

  useEffect(() => {
    void fetchProjects();
    
    // Close menu when clicking anywhere else
    const handleClick = () => setContextMenu(null);
    window.addEventListener("click", handleClick);
    return () => window.removeEventListener("click", handleClick);
  }, []);

  const handleRightClick = (e: React.MouseEvent, id: string, name: string) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, id, name });
  };

  const handleRename = () => {
    if (!contextMenu) return;
    const newName = window.prompt("Rename project:", contextMenu.name);
    if (newName && newName.trim() !== "") {
      void useAppStore.getState().renameProject(contextMenu.id, newName.trim());
    }
  };

  const handleDelete = async () => {
    if (!contextMenu) return;
    
    // Tauri/Browser potvrzení
    const confirmed = window.confirm(`Opravdu chcete smazat "${contextMenu.name}"?`);
    
    if (confirmed) {
      await useAppStore.getState().deleteProject(contextMenu.id);
      setContextMenu(null);
    }
  };

  return (
    <div className="flex h-screen w-full flex-col bg-shell-bg text-shell-text relative">
      <header className="flex h-16 items-center border-b border-shell-border bg-shell-panel px-8">
        <h1 className="text-xl font-bold tracking-tight">Gallery</h1>
      </header>

      <main className="flex-1 overflow-y-auto p-8">
        <div className="grid grid-cols-2 gap-6 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          
          <button
            onClick={() => toggleNewCanvasPopup(true)}
            className="group flex aspect-[4/3] cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-shell-border bg-shell-bg transition hover:border-shell-accent hover:bg-slate-800/50"
          >
            <div className="mb-2 rounded-full bg-shell-accent/20 p-3 text-shell-accent group-hover:bg-shell-accent group-hover:text-white transition">
              <span className="text-2xl font-bold">+</span>
            </div>
            <span className="font-medium text-slate-300 group-hover:text-white">New Canvas</span>
          </button>

          {savedProjects.map((project) => (
            <div 
               key={project.id}
               className="flex aspect-[4/3] cursor-pointer flex-col overflow-hidden rounded-xl border border-shell-border bg-shell-panel transition hover:ring-2 hover:ring-shell-accent"
               onClick={() => void openEditor(project.id)}
               onContextMenu={(e) => handleRightClick(e, project.id, project.name)}
            >
              <div className="flex-1 w-full bg-white flex items-center justify-center overflow-hidden">
                {project.previewUrl ? (
                  <img src={project.previewUrl} alt="Preview" className="w-full h-full object-cover" />
                ) : (
                  <span className="text-slate-300 text-xs">No Preview</span>
                )}
              </div>
              <div className="w-full border-t border-shell-border bg-shell-panel p-3 text-left">
                <h3 className="truncate text-sm font-semibold text-white">{project.name}</h3>
              </div>
            </div>
          ))}

        </div>
      </main>

      {/* Custom Context Menu */}
      {contextMenu && (
        <div 
          className="fixed z-50 w-48 bg-shell-panel border border-shell-border rounded-lg shadow-2xl py-1 overflow-hidden"
          style={{ top: contextMenu.y, left: contextMenu.x }}
        >
          <button onClick={handleRename} className="w-full text-left px-4 py-2 text-sm text-slate-200 hover:bg-shell-accent hover:text-white">
            Rename Artwork
          </button>
          <button onClick={handleDelete} className="w-full text-left px-4 py-2 text-sm text-red-400 hover:bg-red-500 hover:text-white border-t border-shell-border">
            Delete Artwork
          </button>
        </div>
      )}
    </div>
  );
}