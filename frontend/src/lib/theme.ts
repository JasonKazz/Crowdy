export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "crowdy-theme";

// Runs before paint. Keep this static: no user-controlled values enter the script.
export const THEME_BOOTSTRAP_SCRIPT = `(function(){var saved=null,dark=false;try{saved=localStorage.getItem("crowdy-theme")}catch(e){}try{dark=window.matchMedia("(prefers-color-scheme: dark)").matches}catch(e){}var theme=saved==="light"||saved==="dark"?saved:dark?"dark":"light";document.documentElement.dataset.theme=theme;document.documentElement.style.colorScheme=theme})();`;

const listeners = new Set<() => void>();
let initialized = false;
let preference: Theme | null = null;
let systemPreference: MediaQueryList | null = null;

function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark";
}

export function getThemeSnapshot(): Theme {
  return typeof document !== "undefined" && document.documentElement.dataset.theme === "dark"
    ? "dark"
    : "light";
}

export function getServerThemeSnapshot(): Theme {
  return "light";
}

function applyTheme(theme: Theme) {
  const changed = getThemeSnapshot() !== theme;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  if (changed) for (const listener of [...listeners]) listener();
}

function applyPreference() {
  applyTheme(preference ?? (systemPreference?.matches ? "dark" : "light"));
}

function initializeTheme() {
  if (initialized || typeof window === "undefined") return;
  initialized = true;

  try {
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
    preference = isTheme(saved) ? saved : null;
  } catch {
    // Private browsing and blocked storage still allow an in-memory choice.
  }

  try {
    systemPreference = window.matchMedia("(prefers-color-scheme: dark)");
    systemPreference.addEventListener("change", () => {
      if (preference === null) applyPreference();
    });
  } catch {
    systemPreference = null;
  }

  // One shared store survives header remounts and navigation between routes.
  window.addEventListener("storage", (event: StorageEvent) => {
    if (event.key !== THEME_STORAGE_KEY && event.key !== null) return;
    try {
      if (event.storageArea && event.storageArea !== window.localStorage) return;
    } catch {
      // Access to localStorage can be revoked after the page loads.
    }
    preference = isTheme(event.newValue) ? event.newValue : null;
    applyPreference();
  });

  applyPreference();
}

export function subscribeTheme(listener: () => void) {
  initializeTheme();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setTheme(theme: Theme) {
  initializeTheme();
  if (typeof document === "undefined") return;
  preference = theme;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Keep the current session usable even when persistence is unavailable.
  }
  applyTheme(theme);
}
