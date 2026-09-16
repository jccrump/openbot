import { useEffect, useState } from "react";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "openbot.theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

function isPreference(value: string | null): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

export function storedTheme(): ThemePreference {
  if (typeof localStorage === "undefined") {
    return "system";
  }
  const value = localStorage.getItem(STORAGE_KEY);
  return isPreference(value) ? value : "system";
}

export function resolvedTheme(preference: ThemePreference): ResolvedTheme {
  if (preference !== "system") {
    return preference;
  }
  if (typeof window === "undefined") {
    return "light";
  }
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

export function applyTheme(preference: ThemePreference): void {
  document.documentElement.dataset.theme = resolvedTheme(preference);
}

export function useTheme() {
  const [theme, setTheme] = useState<ThemePreference>(storedTheme);

  useEffect(() => {
    applyTheme(theme);
    localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  useEffect(() => {
    if (theme !== "system") {
      return;
    }
    const media = window.matchMedia(DARK_QUERY);
    const onChange = () => applyTheme("system");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [theme]);

  return { theme, setTheme };
}
