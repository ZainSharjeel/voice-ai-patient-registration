import { createContext, useContext, useEffect, useState } from "react";

type Theme = "light" | "dark";

interface ThemeContextType {
  theme: Theme;
  toggleTheme?: () => void;
  switchable: boolean;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

function getSystemTheme(): Theme {
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  return "light";
}

interface ThemeProviderProps {
  children: React.ReactNode;
  defaultTheme?: Theme | "system";
  switchable?: boolean;
}

export function ThemeProvider({
  children,
  defaultTheme = "system",
  switchable = false,
}: ThemeProviderProps) {
  const [theme, setTheme] = useState<Theme>(() => {
    if (switchable) {
      const stored = localStorage.getItem("theme");
      if (stored === "light" || stored === "dark") {
        return stored;
      }
    }
    return defaultTheme === "system" ? getSystemTheme() : defaultTheme;
  });

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "dark") {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }

    // The installed app's title bar (and the mobile browser UI) takes its
    // color from this meta; keep it on the active theme's page background.
    const themeColor = document.querySelector('meta[name="theme-color"]');
    const background = getComputedStyle(root)
      .getPropertyValue("--background")
      .trim();
    if (themeColor && background) {
      themeColor.setAttribute("content", background);
    }

    if (switchable) {
      localStorage.setItem("theme", theme);
    }
  }, [theme, switchable]);

  // Framed inside the Viktor dashboard, the shell sets the theme through the
  // embed bridge (`components/ViktorEmbedBridge.tsx`); follow it so a toggle
  // afterwards starts from the theme the reader actually sees.
  useEffect(() => {
    const handleEmbedTheme = (event: Event) => {
      const next = (event as CustomEvent<Theme>).detail;
      if (next === "light" || next === "dark") setTheme(next);
    };
    window.addEventListener("viktor-embed-theme", handleEmbedTheme);
    return () =>
      window.removeEventListener("viktor-embed-theme", handleEmbedTheme);
  }, []);

  useEffect(() => {
    if (defaultTheme !== "system" || switchable) return;

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = (e: MediaQueryListEvent) => {
      setTheme(e.matches ? "dark" : "light");
    };

    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, [defaultTheme, switchable]);

  const toggleTheme = switchable
    ? () => {
        setTheme(prev => (prev === "light" ? "dark" : "light"));
      }
    : undefined;

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, switchable }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return context;
}
