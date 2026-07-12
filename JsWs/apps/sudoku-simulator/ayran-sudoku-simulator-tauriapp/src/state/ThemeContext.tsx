import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  deleteTheme as dbDeleteTheme,
  getSetting,
  listThemes,
  putSetting,
  putTheme,
  type ThemeRecord,
} from "../lib/db";
import { contrastTextColor, meetsMinimumContrast } from "../lib/colors";

const ACTIVE_THEME_SETTING_KEY = "activeThemeId";

export const DEFAULT_THEME: ThemeRecord = {
  id: "default",
  name: "Default Light",
  background: "#f8fafc",
  foreground: "#1e293b",
  accent: "#2563eb",
  createdAt: 0,
};

export interface NewThemeInput {
  name: string;
  background: string;
  foreground: string;
  accent: string;
}

interface ThemeContextValue {
  themes: ThemeRecord[];
  activeTheme: ThemeRecord;
  activeThemeId: string;
  loaded: boolean;
  setActiveTheme: (id: string) => void;
  saveTheme: (input: NewThemeInput, id?: string) => boolean;
  deleteThemeById: (id: string) => Promise<void>;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [customThemes, setCustomThemes] = useState<ThemeRecord[]>([]);
  const [activeThemeId, setActiveThemeId] = useState<string>(DEFAULT_THEME.id);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      const [themes, storedActiveId] = await Promise.all([
        listThemes(),
        getSetting<string>(ACTIVE_THEME_SETTING_KEY),
      ]);
      setCustomThemes(themes);
      if (storedActiveId) setActiveThemeId(storedActiveId);
      setLoaded(true);
    })();
  }, []);

  const themes = useMemo(() => [DEFAULT_THEME, ...customThemes], [customThemes]);
  const activeTheme = useMemo(
    () => themes.find((t) => t.id === activeThemeId) ?? DEFAULT_THEME,
    [themes, activeThemeId],
  );

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--theme-bg", activeTheme.background);
    root.style.setProperty("--theme-fg", activeTheme.foreground);
    root.style.setProperty("--theme-accent", activeTheme.accent);
    root.style.setProperty("--theme-accent-fg", contrastTextColor(activeTheme.accent));
  }, [activeTheme]);

  const setActiveTheme = useCallback((id: string) => {
    setActiveThemeId(id);
    void putSetting(ACTIVE_THEME_SETTING_KEY, id);
  }, []);

  const saveTheme = useCallback(
    (input: NewThemeInput, id?: string) => {
      if (!meetsMinimumContrast(input.foreground, input.background)) return false;
      const record: ThemeRecord = {
        id: id ?? crypto.randomUUID(),
        name: input.name.trim() || "Custom theme",
        background: input.background,
        foreground: input.foreground,
        accent: input.accent,
        createdAt: id ? (customThemes.find((t) => t.id === id)?.createdAt ?? Date.now()) : Date.now(),
      };
      void putTheme(record);
      setCustomThemes((prev) => {
        const exists = prev.some((t) => t.id === record.id);
        return exists ? prev.map((t) => (t.id === record.id ? record : t)) : [...prev, record];
      });
      return true;
    },
    [customThemes],
  );

  const deleteThemeById = useCallback(
    async (id: string) => {
      if (id === DEFAULT_THEME.id) return;
      await dbDeleteTheme(id);
      setCustomThemes((prev) => prev.filter((t) => t.id !== id));
      if (activeThemeId === id) setActiveTheme(DEFAULT_THEME.id);
    },
    [activeThemeId, setActiveTheme],
  );

  const value: ThemeContextValue = {
    themes,
    activeTheme,
    activeThemeId,
    loaded,
    setActiveTheme,
    saveTheme,
    deleteThemeById,
  };

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
  return ctx;
}
