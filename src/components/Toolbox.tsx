import { useEditorStore } from "../stores/editorStore";

export function Toolbox() {
  const tool = useEditorStore((s) => s.tool);
  const setTool = useEditorStore((s) => s.setTool);

  // Můžeš si sem v budoucnu jednoduše přidávat další nástroje
  const tools = [
    { id: "brush", icon: "🖌", name: "Brush" },
    { id: "eraser", icon: "🧹", name: "Eraser" },
    { id: "select", icon: "⬚", name: "Select" },
  ];

  return (
    <div className="grid grid-cols-3 gap-2">
      {tools.map((t) => (
        <button
          key={t.id}
          onClick={() => setTool(t.id as any)}
          className={`p-3 rounded-lg flex flex-col items-center justify-center gap-1.5 transition-colors ${
            tool === t.id 
              ? "bg-blue-600 text-white shadow-inner" 
              : "bg-shell-bg hover:bg-shell-border"
          }`}
        >
          <span className="text-2xl">{t.icon}</span>
          <span className="text-[10px] uppercase font-bold tracking-wider">{t.name}</span>
        </button>
      ))}
    </div>
  );
}