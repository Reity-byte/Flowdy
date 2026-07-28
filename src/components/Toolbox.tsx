import { Paintbrush, Eraser, MousePointer2, Square, Lasso, Droplet, Fingerprint, PaintBucket, Ruler, Slash, Circle, X, Move } from "lucide-react";
import { useEditorStore } from "../stores/editorStore";
import { useUIStore } from "../stores/uiStore";
import { documentEngineRef } from "../engine/documentEngineRef";
import type { EditorTool } from "../engine/brushTypes";
import { IconButton } from "./Button";

export const TOOLS: { id: EditorTool; icon: typeof Paintbrush; name: string }[] = [
  { id: "brush", icon: Paintbrush, name: "Brush" },
  { id: "eraser", icon: Eraser, name: "Eraser" },
  { id: "select", icon: MousePointer2, name: "Select" },
  { id: "blur", icon: Droplet, name: "Blur" },
  { id: "smudge", icon: Fingerprint, name: "Smudge" },
  { id: "fill", icon: PaintBucket, name: "Fill" },
  { id: "ruler", icon: Ruler, name: "Ruler" },
  { id: "transform", icon: Move, name: "Transform" },
];

/** Always-visible vertical tool rail — one tap to switch tools, no overlay
 * needed (per Section 11's ibis-Paint-derived layout: switching the active
 * tool is too frequent an action to hide behind a sheet). Lives in the
 * left rail in `App.tsx`; the Rectangle/Lasso sub-mode row appears directly
 * beneath it only while Select is active. */
export function Toolbox() {
  const tool = useEditorStore((s) => s.tool);
  const setTool = useEditorStore((s) => s.setTool);
  const selectMode = useEditorStore((s) => s.selectMode);
  const setSelectMode = useEditorStore((s) => s.setSelectMode);
  const rulerType = useEditorStore((s) => s.rulerType);
  const setRulerType = useEditorStore((s) => s.setRulerType);
  const toggleLeftOverlay = useUIStore((s) => s.toggleLeftOverlay);

  return (
    <div className="flex flex-col items-center gap-1.5">
      {TOOLS.map((t) => (
        <IconButton
          key={t.id}
          label={t.name}
          pressed={tool === t.id}
          onClick={() => {
            // Tapping the tool that's ALREADY active opens its settings sheet
            // (tapping it again closes it — toggleLeftOverlay is itself a
            // toggle) instead of just re-selecting a tool that's already
            // selected, which used to be a no-op tap. Switching to a
            // DIFFERENT tool is unchanged: select it, don't touch whatever
            // the settings sheet is doing (if it happens to be open, it'll
            // just start showing the newly-active tool's own settings).
            if (tool === t.id) toggleLeftOverlay("brush");
            else setTool(t.id);
          }}
          className="h-11 w-11 p-0"
        >
          <t.icon size={20} strokeWidth={1.75} />
        </IconButton>
      ))}

      {tool === "select" && (
        <div className="flex flex-col gap-1.5 border-t border-shell-border pt-1.5">
          <IconButton
            label="Rectangle marquee — drag a straight-edged box"
            pressed={selectMode === "rect"}
            onClick={() => setSelectMode("rect")}
            className="h-11 w-11 p-0"
          >
            <Square size={18} strokeWidth={2} />
          </IconButton>
          <IconButton
            label="Lasso — freehand-trace an irregular selection"
            pressed={selectMode === "lasso"}
            onClick={() => setSelectMode("lasso")}
            className="h-11 w-11 p-0"
          >
            <Lasso size={18} strokeWidth={2} />
          </IconButton>
        </div>
      )}

      {tool === "ruler" && (
        <div className="flex flex-col gap-1.5 border-t border-shell-border pt-1.5">
          <IconButton
            label="Straight ruler — snap strokes to a straight edge"
            pressed={rulerType === "straight"}
            onClick={() => setRulerType("straight")}
            className="h-11 w-11 p-0"
          >
            <Slash size={18} strokeWidth={2} />
          </IconButton>
          <IconButton
            label="Circular ruler — snap strokes to a circle"
            pressed={rulerType === "circular"}
            onClick={() => setRulerType("circular")}
            className="h-11 w-11 p-0"
          >
            <Circle size={18} strokeWidth={2} />
          </IconButton>
          <IconButton
            label="Clear ruler"
            pressed={false}
            onClick={() => documentEngineRef.current?.clearRuler()}
            className="h-11 w-11 p-0"
          >
            <X size={18} strokeWidth={2} />
          </IconButton>
        </div>
      )}
    </div>
  );
}
