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
import { ExportModal } from "./components/ExportModal";
import { Toolbox } from "./components/Toolbox"; // NOVÝ IMPORT!

export default function App() {
  const currentScreen = useAppStore((s) => s.currentScreen);
  const notification = useAppStore((s) => s.notification);
  const isExportModalOpen = useAppStore((s) => s.isExportModalOpen);
  const toggleExportModal = useAppStore((s) => s.toggleExportModal);
  
  const { activeTheme, customColors, setTheme, setCustomColor } = useThemeStore();
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  
  // NOVÉ: Stav pro Zen/Focus mód
  const [isFocusMode, setIsFocusMode] = useState(false);

  const canvasWidth = useAppStore((s) => s.canvasWidth);
  const canvasHeight = useAppStore((s) => s.canvasHeight);

  // NOVÉ: Klávesová zkratka Tab pro přepnutí Focus módu
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        setIsFocusMode(prev => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

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

  return (
    <div className="h-full w-full relative bg-shell-bg text-shell-text overflow-hidden">
      
      {currentScreen === "gallery" ? (
        <div className="h-full w-full">
          <div className="absolute top-4 right-8 z-10">
            <button onClick={() => setIsSettingsOpen(true)} className="px-4 py-2 bg-shell-panel border border-shell-border rounded-lg shadow-sm hover:brightness-110 transition font-bold">
              ⚙️ Settings
            </button>
          </div>
          <Gallery />
          <NewCanvasModal />
        </div>
      ) : (
        <div className="flex h-full flex-col overflow-hidden relative">
          
          {/* Plovoucí tlačítko Focus módu (viditelné hlavně když se schová horní lišta) */}
          <button 
            onClick={() => setIsFocusMode(!isFocusMode)}
            className={`absolute z-50 px-3 py-1.5 bg-shell-panel border border-shell-border rounded-lg shadow-lg hover:brightness-110 transition-all font-bold text-xs tracking-wider opacity-50 hover:opacity-100 ${isFocusMode ? 'top-4 right-4' : 'top-4 right-[280px]'}`}
            title="Toggle Focus Mode (Tab)"
          >
            {isFocusMode ? "⤡ Show UI" : "⤢ Focus"}
          </button>

          {/* HORNÍ LIŠTA: Vyjede nahoru */}
          <div className={`transition-all duration-500 ease-in-out ${isFocusMode ? '-mt-20 opacity-0' : 'mt-0 opacity-100'}`}>
            <TopBar />
          </div>

          {/* KONTEJNER PRO PANELY: Dynamický gap zajistí, že po zmizení panelů nezbydou prázdné díry */}
          <div className={`flex min-h-0 flex-1 p-4 overflow-hidden transition-all duration-500 ease-in-out ${isFocusMode ? 'gap-0' : 'gap-4'}`}>
            
            {/* LEVÝ PANEL: Animace šířky do nuly */}
            <div className={`transition-all duration-500 ease-in-out overflow-hidden ${isFocusMode ? 'w-0 opacity-0' : 'w-64 opacity-100'}`}>
              <aside className="w-64 shrink-0 flex flex-col gap-4 overflow-y-auto custom-scrollbar pr-1 h-full">
                <Drawer title="🎨 Brush Settings" defaultOpen={true}>
                  <ToolPalette />
                </Drawer>
                <Drawer title="🌈 Color Picker" defaultOpen={true}>
                  <ColorPicker />
                </Drawer>
              </aside>
            </div>

            {/* STŘED (Plátno): Automaticky se roztáhne do uvolněného prostoru */}
            <main className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 relative">
              <p className={`shrink-0 text-xs font-medium opacity-50 text-center tracking-wide transition-opacity ${isFocusMode ? 'opacity-0 h-0 overflow-hidden' : 'opacity-50'}`}>
                Artboard {canvasWidth}×{canvasHeight}px
              </p>
              <div className="relative w-full h-full min-h-0 flex-1 border border-shell-border rounded-xl overflow-hidden shadow-sm bg-shell-panel">
                <CanvasStage />
              </div>
            </main>

            {/* PRAVÝ PANEL: Animace šířky do nuly */}
            <div className={`transition-all duration-500 ease-in-out overflow-hidden ${isFocusMode ? 'w-0 opacity-0' : 'w-64 opacity-100'}`}>
              <aside className="w-64 shrink-0 flex flex-col gap-4 overflow-y-auto custom-scrollbar pl-1 h-full">
                <Drawer title="📚 Layers" defaultOpen={true}>
                  <LayerPanel />
                </Drawer>
                <Drawer title="🛠 Tools" defaultOpen={true}>
                  <Toolbox />
                </Drawer>
              </aside>
            </div>
          </div>
        </div>
      )}

      {isExportModalOpen && <ExportModal onClose={() => toggleExportModal(false)} />}

      {notification && (
        <div className="fixed bottom-10 left-1/2 -translate-x-1/2 bg-blue-600 text-white px-8 py-3 rounded-full shadow-2xl z-[9999] font-bold pointer-events-none uppercase tracking-wider">
          {notification}
        </div>
      )}

      {/* Nastavení (bez změny) ... */}
      {isSettingsOpen && currentScreen === "gallery" && (
        /* ... Zbytek tvého kódu s modálem nastavení ... */
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
                <ColorInput label="Accent" value={customColors.accent} onChange={(c) => setCustomColor("accent", c)} />
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

// Tyto komponenty nechej tak, jak jsou z minula
function Drawer({ title, children, defaultOpen = true }: { title: string, children: React.ReactNode, defaultOpen?: boolean }) {
  /* ... z minula ... */
  const [isOpen, setIsOpen] = useState(defaultOpen);
  return (
    <div className="flex flex-col rounded-xl border border-shell-border bg-shell-panel shrink-0 shadow-sm">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center justify-between px-4 py-3 hover:bg-shell-border/40 transition-colors text-xs font-bold uppercase tracking-widest text-shell-text rounded-xl"
      >
        <span>{title}</span>
        <span className="opacity-50">{isOpen ? '▼' : '▶'}</span>
      </button>
      {isOpen && (
        <div className="p-4 border-t border-shell-border flex flex-col gap-2">
          {children}
        </div>
      )}
    </div>
  );
}

function ThemeBtn({ label, id, active, onClick }: { label: string, id: string, active: string, onClick: () => void }) {
  return (
    <button onClick={onClick} className={`py-2 px-3 rounded-lg border text-sm font-medium transition ${active === id ? "border-blue-600 bg-blue-600 text-white shadow-inner" : "border-shell-border bg-shell-bg hover:bg-shell-border/50"}`}>
      {label}
    </button>
  );
}

function ColorInput({ label, value, onChange }: { label: string, value: string, onChange: (v: string) => void }) {
  return (
    <div className="flex justify-between items-center">
      <span className="text-sm font-medium">{label}</span>
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} className="w-8 h-8 rounded cursor-pointer border-0 p-0 bg-transparent" />
    </div>
  );
}