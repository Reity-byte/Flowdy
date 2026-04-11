import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ThemePreset = "dark" | "light" | "pink" | "custom";

type ThemeColors = {
  bg: string;
  panel: string;
  accent: string;
  border: string;
  text: string;
};

interface ThemeState {
  activeTheme: ThemePreset;
  customColors: ThemeColors;
  setTheme: (theme: ThemePreset) => void;
  setCustomColor: (key: keyof ThemeColors, color: string) => void;
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      activeTheme: "pink", // Výchozí téma
      customColors: {
        bg: "#1e1e2e",
        panel: "#181825",
        accent: "#cba6f7",
        border: "#313244",
        text: "#cdd6f4",
      },
      setTheme: (theme) => set({ activeTheme: theme }),
      setCustomColor: (key, color) =>
        set((state) => ({
          customColors: { ...state.customColors, [key]: color },
        })),
    }),
    { name: "flowdy-theme-storage" }
  )
);