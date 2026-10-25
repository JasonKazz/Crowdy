import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { THEME_BOOTSTRAP_SCRIPT, getServerThemeSnapshot, getThemeSnapshot } from "../src/lib/theme.ts";

assert.equal(getServerThemeSnapshot(), "light");
assert.equal(getThemeSnapshot(), "light", "Server rendering must not access browser APIs");

function browser({ dark = false, saved = null, blocked = false } = {}) {
  const values = new Map(saved === null ? [] : [["crowdy-theme", saved]]);
  const events = new Map();
  const systemListeners = new Set();
  const document = { documentElement: { dataset: {}, style: {} } };
  const storage = {
    getItem(key) {
      if (blocked) throw new Error("Storage blocked");
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      if (blocked) throw new Error("Storage blocked");
      values.set(key, value);
    },
  };
  const media = {
    matches: dark,
    addEventListener(event, callback) {
      assert.equal(event, "change");
      systemListeners.add(callback);
    },
  };
  const window = {
    localStorage: storage,
    matchMedia(query) {
      assert.equal(query, "(prefers-color-scheme: dark)");
      return media;
    },
    addEventListener(event, callback) {
      if (!events.has(event)) events.set(event, new Set());
      events.get(event).add(callback);
    },
  };
  return {
    document,
    window,
    storage,
    values,
    bootstrap() {
      runInNewContext(THEME_BOOTSTRAP_SCRIPT, { document, window, localStorage: storage });
    },
    changeSystem(nextDark) {
      media.matches = nextDark;
      for (const callback of systemListeners) callback({ matches: nextDark });
    },
    storageEvent(newValue, key = "crowdy-theme") {
      if (newValue === null) values.delete("crowdy-theme");
      else values.set("crowdy-theme", newValue);
      for (const callback of events.get("storage") ?? []) callback({ key, newValue, storageArea: storage });
    },
  };
}

for (const options of [
  { dark: true, expected: "dark" },
  { dark: false, expected: "light" },
  { dark: true, saved: "light", expected: "light" },
  { dark: false, saved: "dark", expected: "dark" },
  { dark: true, saved: "invalid", expected: "dark" },
  { dark: true, blocked: true, expected: "dark" },
]) {
  const env = browser(options);
  env.bootstrap();
  assert.equal(env.document.documentElement.dataset.theme, options.expected);
  assert.equal(env.document.documentElement.style.colorScheme, options.expected);
}

let scenario = 0;
async function loadStore(env) {
  globalThis.document = env.document;
  globalThis.window = env.window;
  return import(new URL(`../src/lib/theme.ts?scenario=${scenario++}`, import.meta.url));
}

try {
  const env = browser({ dark: true });
  env.bootstrap();
  const store = await loadStore(env);
  let updates = 0;
  const unsubscribe = store.subscribeTheme(() => updates++);
  assert.equal(store.getThemeSnapshot(), "dark");
  env.changeSystem(false);
  assert.equal(store.getThemeSnapshot(), "light", "Before choosing, follow OS theme changes");
  assert.equal(updates, 1);

  store.setTheme("dark");
  assert.equal(env.values.get("crowdy-theme"), "dark", "An explicit choice must persist");
  assert.equal(env.document.documentElement.style.colorScheme, "dark");
  env.changeSystem(true);
  env.changeSystem(false);
  assert.equal(store.getThemeSnapshot(), "dark", "An explicit choice must override later OS changes");

  env.storageEvent("light");
  assert.equal(store.getThemeSnapshot(), "light", "A change from another tab must apply immediately");
  env.storageEvent("dark", "unrelated-key");
  assert.equal(store.getThemeSnapshot(), "light", "Unrelated storage changes must be ignored");
  env.storageEvent(null, null);
  env.changeSystem(true);
  assert.equal(store.getThemeSnapshot(), "dark", "Clearing the saved choice restores OS preference tracking");

  unsubscribe();
  const previousUpdates = updates;
  store.setTheme("light");
  assert.equal(updates, previousUpdates, "Unmounted controls must stop receiving updates");
  let remountUpdates = 0;
  const unsubscribeRemount = store.subscribeTheme(() => remountUpdates++);
  assert.equal(store.getThemeSnapshot(), "light", "A remounted header must retain the choice");
  store.setTheme("dark");
  assert.equal(remountUpdates, 1);
  unsubscribeRemount();

  const reloaded = browser({ dark: false, saved: "dark" });
  reloaded.bootstrap();
  const reloadStore = await loadStore(reloaded);
  const unsubscribeReload = reloadStore.subscribeTheme(() => {});
  assert.equal(reloadStore.getThemeSnapshot(), "dark", "Reloading must restore the explicit choice");
  unsubscribeReload();

  const blocked = browser({ dark: true, blocked: true });
  blocked.bootstrap();
  const blockedStore = await loadStore(blocked);
  const unsubscribeBlocked = blockedStore.subscribeTheme(() => {});
  assert.equal(blockedStore.getThemeSnapshot(), "dark");
  blocked.changeSystem(false);
  assert.equal(blockedStore.getThemeSnapshot(), "light");
  assert.doesNotThrow(() => blockedStore.setTheme("dark"));
  blocked.changeSystem(true);
  blocked.changeSystem(false);
  assert.equal(blockedStore.getThemeSnapshot(), "dark", "Blocked storage must still preserve a choice for the current session");
  unsubscribeBlocked();
} finally {
  delete globalThis.document;
  delete globalThis.window;
}

console.log("Theme checks passed: before-paint system/saved preference, hydration-safe snapshot, OS changes, persistence, cross-tab sync, remounts, and blocked storage.");
