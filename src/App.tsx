import { useEffect, useState } from "react";
import type { ComponentType } from "react";
import { Settings, Minimize2, X, Flower2, Moon, Sun, SlidersHorizontal, Layers, Palette as SwatchIcon } from "lucide-react";
import { useAppStore } from "./stores/appStore";
import { useThemeStore } from "./stores/themeStore";
import { useEditorStore } from "./stores/editorStore";
import { useUIStore } from "./stores/uiStore";

import { CanvasStage } from "./components/CanvasStage";
import { documentEngineRef } from "./engine/documentEngineRef";
import { ColorPicker } from "./components/ColorPicker";
import { LayerPanel } from "./components/LayerPanel";
import { ToolPalette } from "./components/ToolPalette";
import { TopBar } from "./components/TopBar";
import { Gallery } from "./components/Gallery";
import { NewCanvasModal } from "./components/NewCanvasModal";
import { ExportModal } from "./components/ExportModal";
import { Toolbox } from "./components/Toolbox";
import { OverlayPanel } from "./components/OverlayPanel";
import { Button, IconButton } from "./components/Button";

export default function App() {
  const currentScreen = useAppStore((s) => s.currentScreen);
  const notification = useAppStore((s) => s.notification);
  const isExportModalOpen = useAppStore((s) => s.isExportModalOpen);
  const toggleExportModal = useAppStore((s) => s.toggleExportModal);
  
  const { activeTheme, customColors, setTheme, setCustomColor } = useThemeStore();
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  
  // FOCUS MÓD (Zen mód)
  const [isFocusMode, setIsFocusMode] = useState(false);

  const canvasWidth = useAppStore((s) => s.canvasWidth);
  const canvasHeight = useAppStore((s) => s.canvasHeight);

  const currentColor = useEditorStore((s) => s.color);
  const leftOverlay = useUIStore((s) => s.leftOverlay);
  const rightOverlay = useUIStore((s) => s.rightOverlay);
  const toggleLeftOverlay = useUIStore((s) => s.toggleLeftOverlay);
  const toggleRightOverlay = useUIStore((s) => s.toggleRightOverlay);
  const closeOverlays = useUIStore((s) => s.closeOverlays);

  // Klávesová zkratka Tab pro přepnutí Focus módu (jen v editoru, ne při psaní do vstupu)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      if (useAppStore.getState().currentScreen !== "editor") return;
      const active = document.activeElement as HTMLElement | null;
      const tag = active?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || active?.isContentEditable) return;
      e.preventDefault();
      setIsFocusMode(prev => !prev);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Ensure the canvas resizes immediately when focus mode changes
  useEffect(() => {
    // An open overlay panel makes no sense over a canvas-only Focus view.
    if (isFocusMode) closeOverlays();

    // Call resize immediately and a few times afterwards (staggered)
    // so we catch the host size both before/during/after the CSS transition.
    try { documentEngineRef.current?.forceResize(); } catch {}

    const timers: number[] = [];
    timers.push(window.setTimeout(() => { try { documentEngineRef.current?.forceResize(); } catch {} }, 80));
    timers.push(window.setTimeout(() => { try { documentEngineRef.current?.forceResize(); } catch {} }, 200));
    // After CSS transition duration (500ms) + small buffer
    timers.push(window.setTimeout(() => { try { documentEngineRef.current?.forceResize(); } catch {} }, 560));

    return () => timers.forEach((t) => clearTimeout(t));
  }, [isFocusMode]);

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
            <Button variant="secondary" onClick={() => setIsSettingsOpen(true)} className="px-4 py-2 font-bold">
              <Settings size={16} strokeWidth={2} /> Settings
            </Button>
          </div>
          <Gallery />
          <NewCanvasModal />
        </div>
      ) : (
        <div className="flex h-full flex-col overflow-hidden relative">
          
          {/* Plovoucí tlačítko pro NÁVRAT z Focus módu — only needs to float
              when TopBar itself is faded out/hidden (Focus Mode active).
              While TopBar is visible, its own "Focus" button (a normal flex
              item, not absolutely positioned) is what enters Focus Mode —
              see TopBar.tsx. Rendering only one of the two at a time is what
              actually fixes the overlap with Undo/Redo: the old version
              rendered this floating button unconditionally at a fixed
              right-24 offset that assumed empty space TopBar's own content
              occupies. */}
          {isFocusMode && (
            <Button
              variant="secondary"
              elevated
              onClick={() => setIsFocusMode(false)}
              className="absolute z-50 top-4 right-4 px-3 py-1.5 text-xs font-bold tracking-wider opacity-50 hover:opacity-100"
              title="Toggle Focus Mode (Tab)"
            >
              <Minimize2 size={13} strokeWidth={2} /> Show UI
            </Button>
          )}

          {/* HORNÍ LIŠTA */}
          <div className={`transition-all duration-500 ease-in-out ${isFocusMode ? '-mt-20 opacity-0' : 'mt-0 opacity-100'}`}>
            <TopBar onEnterFocusMode={() => setIsFocusMode(true)} />
          </div>

          <div className={`flex min-h-0 flex-1 p-4 overflow-hidden transition-all duration-500 ease-in-out ${isFocusMode ? 'gap-0' : 'gap-3'}`}>

            {/* LEFT RAIL — always-visible tool switcher + Brush Settings toggle. Slim
                (not a wide docked sidebar): switching tools is a one-tap action, so it
                stays on the rail itself; only the heavier Brush Settings sheet opens
                on demand as a floating OverlayPanel below. */}
            <div className={`transition-all duration-500 ease-in-out overflow-hidden min-w-0 ${isFocusMode ? 'w-0 opacity-0' : 'w-16 opacity-100'}`}>
              <aside className="flex h-full w-16 shrink-0 flex-col items-center gap-1.5 overflow-y-auto custom-scrollbar rounded-xl border border-shell-border bg-shell-panel py-3 shadow-sm">
                <Toolbox />
                <div className="my-1 h-px w-8 bg-shell-border" />
                <IconButton
                  label="Brush Settings"
                  pressed={leftOverlay === "brush"}
                  onClick={() => toggleLeftOverlay("brush")}
                  className="h-11 w-11 p-0"
                >
                  <SlidersHorizontal size={20} strokeWidth={1.75} />
                </IconButton>
              </aside>
            </div>

            {/* STŘED (Plátno) — now the `relative` anchor both the canvas frame and
                the floating overlay panels position against. */}
            <main className="relative flex min-h-0 min-w-0 flex-1 flex-col gap-2">
              <p className={`shrink-0 text-xs font-medium opacity-50 text-center tracking-wide transition-opacity ${isFocusMode ? 'opacity-0 h-0 overflow-hidden' : 'opacity-50'}`}>
                Artboard {canvasWidth}×{canvasHeight}px
              </p>
              <div className="relative w-full h-full min-h-0 flex-1 border border-shell-border rounded-xl overflow-hidden shadow-sm bg-shell-panel">
                <CanvasStage />

                {leftOverlay === "brush" && (
                  <OverlayPanel icon={SlidersHorizontal} title="Brush Settings" side="left" onClose={() => toggleLeftOverlay("brush")}>
                    <ToolPalette />
                  </OverlayPanel>
                )}
                {rightOverlay === "color" && (
                  <OverlayPanel icon={SwatchIcon} title="Color Picker" side="right" onClose={() => toggleRightOverlay("color")}>
                    <ColorPicker />
                  </OverlayPanel>
                )}
                {rightOverlay === "layers" && (
                  <OverlayPanel icon={Layers} title="Layers" side="right" onClose={() => toggleRightOverlay("layers")} widthClass="w-80">
                    <LayerPanel />
                  </OverlayPanel>
                )}
              </div>
            </main>

            {/* RIGHT RAIL — always-visible current-color swatch + Layers toggle,
                the quick-access status strip Section 11 called for (active color
                visible without opening anything). */}
            <div className={`transition-all duration-500 ease-in-out overflow-hidden min-w-0 ${isFocusMode ? 'w-0 opacity-0' : 'w-16 opacity-100'}`}>
              <aside className="flex h-full w-16 shrink-0 flex-col items-center gap-1.5 overflow-y-auto custom-scrollbar rounded-xl border border-shell-border bg-shell-panel py-3 shadow-sm">
                <button
                  type="button"
                  title={`Color Picker — current color ${currentColor}`}
                  aria-label="Color Picker"
                  onClick={() => toggleRightOverlay("color")}
                  className={`h-11 w-11 shrink-0 rounded-lg border-2 shadow-inner transition ${rightOverlay === "color" ? "border-shell-accent" : "border-shell-border hover:border-shell-accent/60"}`}
                  style={{ backgroundColor: currentColor }}
                />
                <div className="my-1 h-px w-8 bg-shell-border" />
                <IconButton
                  label="Layers"
                  pressed={rightOverlay === "layers"}
                  onClick={() => toggleRightOverlay("layers")}
                  className="h-11 w-11 p-0"
                >
                  <Layers size={20} strokeWidth={1.75} />
                </IconButton>
              </aside>
            </div>

          </div>
        </div>
      )}

      {isExportModalOpen && <ExportModal onClose={() => toggleExportModal(false)} />}

      {notification && (
        <div className="fixed bottom-10 left-1/2 -translate-x-1/2 bg-shell-accent text-white px-8 py-3 rounded-full shadow-2xl z-[9999] font-bold pointer-events-none uppercase tracking-wider">
          {notification}
        </div>
      )}

      {isSettingsOpen && currentScreen === "gallery" && (
        <div className="absolute inset-0 bg-black/50 flex items-center justify-center z-50 backdrop-blur-sm">
          <div className="bg-shell-panel border border-shell-border p-6 rounded-2xl w-96 shadow-2xl">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xl font-bold">Theme Settings</h2>
              <IconButton label="Close" onClick={() => setIsSettingsOpen(false)}><X size={18} strokeWidth={2} /></IconButton>
            </div>

            <div className="grid grid-cols-2 gap-3 mb-6">
              <ThemeBtn icon={Flower2} label="Pink" id="pink" active={activeTheme} onClick={() => setTheme("pink")} />
              <ThemeBtn icon={Moon} label="Dark" id="dark" active={activeTheme} onClick={() => setTheme("dark")} />
              <ThemeBtn icon={Sun} label="Light" id="light" active={activeTheme} onClick={() => setTheme("light")} />
              <ThemeBtn icon={SlidersHorizontal} label="Custom" id="custom" active={activeTheme} onClick={() => setTheme("custom")} />
            </div>
            
            {activeTheme === "custom" && (
              <div className="space-y-3 pt-4 border-t border-[color-mix(in_srgb,var(--shell-border),transparent_55%)]">
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

function ThemeBtn({ icon: Icon, label, id, active, onClick }: { icon: ComponentType<{ size?: number; strokeWidth?: number }>, label: string, id: string, active: string, onClick: () => void }) {
  return (
    <Button variant="secondary" pressed={active === id} onClick={onClick} className="py-2 px-3 text-sm">
      <Icon size={15} strokeWidth={2} /> {label}
    </Button>
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