import { useEffect, useState } from "react";
import { useAppStore } from "./stores/appStore";
import { useThemeStore } from "./stores/themeStore";

import { CanvasStage } from "./components/CanvasStage";
import { ColorPicker } from "./components/ColorPicker";
import { LayerPanel } from "./components/LayerPanel";
import { ToolPalette } from "./components/ToolPalette";
import { TopBar } from "./components/TopBar";
import { Gallery } from "./components/Gallery";
import { NewCanvasModal } from "./components/NewCanvasModal";

export default function App() {
  const currentScreen = useAppStore((s) => s.currentScreen);
  const { activeTheme, customColors, setTheme, setCustomColor } = useThemeStore();
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  const canvasWidth = useAppStore((s) => s.canvasWidth);
  const canvasHeight = useAppStore((s) => s.canvasHeight);

  // ZAJIŠŤUJE ŽIVOU ZMĚNU BAREV
  useEffect(() => {
    const html = document.documentElement;
    if (activeTheme === "custom") {
      html.setAttribute("data-theme", "custom");
      html.style.setProperty("--shell-bg", customColors.bg);
      html.style.setProperty("--shell-panel", customColors.panel);
      html.style.setProperty("--shell-accent", customColors.accent);
      html.style.setProperty("--shell-border", customColors.border);
      html.style.setProperty("--shell-text", customColors.text);
    } else {
      html.setAttribute("data-theme", activeTheme);
      html.style.removeProperty("--shell-bg");
      html.style.removeProperty("--shell-panel");
      html.style.removeProperty("--shell-accent");
      html.style.removeProperty("--shell-border");
      html.style.removeProperty("--shell-text");
    }
  }, [activeTheme, customColors]);

  // Vykreslení galerie
  if (currentScreen === "gallery") {
    return (
      <div className="h-full bg-shell-bg text-shell-text relative">
        {/* TLAČÍTKO NASTAVENÍ V PRAVÉM HORNÍM ROHU GALERIE */}
        <div className="absolute top-4 right-8 z-10">
          <button 
            onClick={() => setIsSettingsOpen(true)}
            className="px-4 py-2 bg-shell-panel border border-shell-border rounded-lg shadow-sm hover:brightness-110 transition font-bold"
          >
            ⚙️ Settings
          </button>
        </div>
        
        <Gallery />
        <NewCanvasModal />

        {/* MODÁLNÍ OKNO NASTAVENÍ TÉMATU */}
        {isSettingsOpen && (
          <div className="absolute inset-0 bg-black/50 flex items-center justify-center z-50 backdrop-blur-sm">
            <div className="bg-shell-panel border border-shell-border p-6 rounded-2xl w-96 shadow-2xl">
              <div className="flex justify-between items-center mb-6">
                <h2 className="text-xl font-bold">Theme Settings</h2>
                <button onClick={() => setIsSettingsOpen(false)} className="opacity-70 hover:opacity-100">✕</button>
              </div>

              <div className="grid grid-cols-2 gap-3 mb-6">
                <ThemeBtn label="🌸 Pink" id="pink" active={activeTheme} onClick={() => setTheme("pink")} />
                <ThemeBtn label="🌙 Dark" id="dark" active={activeTheme} onClick={() => setTheme("dark")} />
                <ThemeBtn label="☀️ Light" id="light" active={activeTheme} onClick={() => setTheme("light")} />
                <ThemeBtn label="🎨 Custom" id="custom" active={activeTheme} onClick={() => setTheme("custom")} />
              </div>

              {activeTheme === "custom" && (
                <div className="space-y-3 pt-4 border-t border-shell-border">
                  <ColorInput label="Background" value={customColors.bg} onChange={(c) => setCustomColor("bg", c)} />
                  <ColorInput label="Panels" value={customColors.panel} onChange={(c) => setCustomColor("panel", c)} />
                  <ColorInput label="Accent (Buttons)" value={customColors.accent} onChange={(c) => setCustomColor("accent", c)} />
                  <ColorInput label="Borders" value={customColors.border} onChange={(c) => setCustomColor("border", c)} />
                  <ColorInput label="Text" value={customColors.text} onChange={(c) => setCustomColor("text", c)} />
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    );
  }

  // Vykreslení Editoru
  return (
    <div className="flex h-full flex-col bg-shell-bg text-shell-text">
      <TopBar />
      <div className="flex min-h-0 flex-1 gap-3 p-3">
        <aside className="flex w-64 shrink-0 flex-col gap-3 overflow-y-auto">
          <ToolPalette />
          <ColorPicker />
        </aside>
        <main className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
          <p className="shrink-0 text-xs opacity-70">
            Artboard {canvasWidth}×{canvasHeight}px — brush paints on the active layer.
          </p>
          <div className="min-h-0 flex-1">
            <CanvasStage />
          </div>
        </main>
        <aside className="flex w-56 shrink-0 flex-col">
          <LayerPanel />
        </aside>
      </div>
    </div>
  );
}

// Pomocné UI komponenty pro Nastavení
function ThemeBtn({ label, id, active, onClick }: { label: string, id: string, active: string, onClick: () => void }) {
  return (
    <button 
      onClick={onClick}
      className={`py-2 px-3 rounded-lg border text-sm font-medium transition ${active === id ? "border-shell-accent bg-shell-accent text-white" : "border-shell-border bg-shell-bg hover:brightness-110"}`}
    >
      {label}
    </button>
  );
}

function ColorInput({ label, value, onChange }: { label: string, value: string, onChange: (v: string) => void }) {
  return (
    <div className="flex justify-between items-center">
      <span className="text-sm font-medium">{label}</span>
      <input 
        type="color" 
        value={value} 
        onChange={(e) => onChange(e.target.value)}
        className="w-8 h-8 rounded cursor-pointer border-0 p-0 bg-transparent"
      />
    </div>
  );
}