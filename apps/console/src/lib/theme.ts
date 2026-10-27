export type Theme = "light" | "dark";
export type ThemePreference = Theme | "system";
export const THEME_KEY = "safenet-theme";

export function parseTheme(value: string | null): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): Theme {
  return preference === "system" ? (systemDark ? "dark" : "light") : preference;
}

export function applyTheme(theme: Theme, doc: Document = document) {
  const root = doc.documentElement;
  root.dataset.theme = theme;
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
  doc.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#10161e" : "#f3f6f8");
}

// Runs in the document head before the first paint. The stored value is validated,
// never interpolated into markup. Keep the resolution contract covered by tests.
export const themeBootstrap = `(() => {
  let preference = "system";
  try { const saved = localStorage.getItem("${THEME_KEY}"); if (saved === "light" || saved === "dark") preference = saved; } catch {}
  const dark = preference === "dark" || (preference === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  const root = document.documentElement;
  root.dataset.theme = dark ? "dark" : "light";
  root.classList.toggle("dark", dark);
  root.style.colorScheme = dark ? "dark" : "light";
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", dark ? "#10161e" : "#f3f6f8");
})();`;
