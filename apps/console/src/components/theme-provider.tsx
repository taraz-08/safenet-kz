"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { applyTheme, parseTheme, resolveTheme, THEME_KEY, type Theme, type ThemePreference } from "@/lib/theme";

type ThemeState = { preference: ThemePreference; theme: Theme; setPreference: (value: ThemePreference) => void };
const ThemeContext = createContext<ThemeState | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, updatePreference] = useState<ThemePreference>("system");
  const [theme, updateTheme] = useState<Theme>("dark");

  const display = useCallback((value: ThemePreference) => {
    const resolved = resolveTheme(value, window.matchMedia("(prefers-color-scheme: dark)").matches);
    updatePreference(value);
    updateTheme(resolved);
    applyTheme(resolved);
  }, []);

  useEffect(() => {
    let initial: ThemePreference = "system";
    try { initial = parseTheme(localStorage.getItem(THEME_KEY)); } catch { /* Private storage can be unavailable. */ }
    display(initial);
    // Synchronize other tabs, including when the saved preference is cleared.
    const sync = (event: StorageEvent) => {
      if (event.key === THEME_KEY || event.key === null) display(parseTheme(event.newValue));
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [display]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const syncSystem = () => { if (preference === "system") display("system"); };
    media.addEventListener("change", syncSystem);
    return () => media.removeEventListener("change", syncSystem);
  }, [display, preference]);

  const setPreference = useCallback((value: ThemePreference) => {
    display(value);
    try { localStorage.setItem(THEME_KEY, value); } catch { /* The choice still works for this visit. */ }
  }, [display]);

  return <ThemeContext.Provider value={{ preference, theme, setPreference }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("Missing theme provider");
  return context;
}
