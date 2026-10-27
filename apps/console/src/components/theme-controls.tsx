"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "./theme-provider";
import { useWorkspace } from "./providers";
import type { Locale } from "@/lib/schema";

export const themeCopy = {
  ru: { title: "Оформление", light: "Светлая", dark: "Тёмная", system: "Системная", hint: "Выбор сохраняется в этом браузере. Режим устройства меняет тему автоматически.", toLight: "Включить светлую тему", toDark: "Включить тёмную тему" },
  kk: { title: "Безендіру", light: "Жарық", dark: "Қараңғы", system: "Жүйелік", hint: "Таңдау осы браузерде сақталады. Құрылғы режимі тақырыпты автоматты түрде өзгертеді.", toLight: "Жарық тақырыпты қосу", toDark: "Қараңғы тақырыпты қосу" },
  en: { title: "Appearance", light: "Light", dark: "Dark", system: "System", hint: "Saved in this browser. Device mode follows your system appearance automatically.", toLight: "Switch to light theme", toDark: "Switch to dark theme" },
} satisfies Record<Locale, Record<string, string>>;

export function ThemeToggle() {
  const { locale } = useWorkspace();
  const { theme, setPreference } = useTheme();
  const c = themeCopy[locale];
  const label = theme === "dark" ? c.toLight : c.toDark;
  const Icon = theme === "dark" ? Moon : Sun;
  return <button type="button" className="theme-toggle" aria-label={label} title={label} onClick={() => setPreference(theme === "dark" ? "light" : "dark")}>
    <Icon size={17} strokeWidth={1.8} /><span>{c[theme]}</span>
  </button>;
}

export function ThemePreferenceControl() {
  const { locale } = useWorkspace();
  const { preference, setPreference } = useTheme();
  const c = themeCopy[locale];
  const choices = [{ id: "light", Icon: Sun }, { id: "dark", Icon: Moon }, { id: "system", Icon: Monitor }] as const;
  return <fieldset className="theme-preference"><legend>{c.title}</legend><div className="theme-options">
    {choices.map(({ id, Icon }) => <button key={id} type="button" aria-pressed={preference === id} onClick={() => setPreference(id)}><Icon size={18} /><span>{c[id]}</span></button>)}
  </div><p>{c.hint}</p></fieldset>;
}
