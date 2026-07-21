import { Image, Save, Download, Undo2, Redo2, Maximize2 } from "lucide-react";
import { useHistoryStore } from "../stores/historyStore";
import { useAppStore } from "../stores/appStore";
import { documentEngineRef } from "../engine/documentEngineRef";
import { Button } from "./Button";

export function TopBar({ onEnterFocusMode }: { onEnterFocusMode: () => void }) {
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
        <Button variant="ghost" onClick={() => void openGallery()} className="px-3 py-1.5">
          <Image size={16} strokeWidth={2} /> Gallery
        </Button>
        <Button variant="primary" onClick={() => saveProject()} className="px-3 py-1.5">
          <Save size={16} strokeWidth={2} /> Save Artwork
        </Button>
        <Button variant="ghost" onClick={() => toggleExportModal(true)} className="px-3 py-1.5">
          <Download size={16} strokeWidth={2} /> Export
        </Button>
      </div>

      {/* PROSTŘEDNÍ ČÁST */}
      <div className="flex gap-3 items-center justify-center w-1/3">
        <span className="text-sm font-bold uppercase tracking-widest opacity-50">Flowdy</span>
      </div>

      {/* PRAVÁ ČÁST */}
      <div className="flex gap-2 w-1/3 justify-end">
        <Button variant="ghost" onClick={handleUndo} disabled={!canUndo} className="px-4 py-1.5">
          <Undo2 size={16} strokeWidth={2} /> Undo
        </Button>
        <Button variant="ghost" onClick={handleRedo} disabled={!canRedo} className="px-4 py-1.5">
          Redo <Redo2 size={16} strokeWidth={2} />
        </Button>
        {/* Lives here (a normal flex item, not a floating absolute button)
            specifically so it can never overlap Undo/Redo — the previous
            floating version was positioned assuming empty space that this
            row's own content actually occupies. Only needs to exist here
            while TopBar itself is visible; once Focus Mode is entered and
            TopBar fades out, App.tsx's own floating "Show UI" button takes
            over (TopBar isn't rendered/visible then, so this one doesn't
            need to keep working past the entry click). */}
        <Button variant="secondary" elevated onClick={onEnterFocusMode} className="px-3 py-1.5 text-xs font-bold tracking-wider" title="Toggle Focus Mode (Tab)">
          <Maximize2 size={13} strokeWidth={2} /> Focus
        </Button>
      </div>
    </div>
  );
}
