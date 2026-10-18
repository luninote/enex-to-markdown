// Shortcut data without the editor, so the app's key handling doesn't load Tiptap (the editor is its own chunk).
export const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || "");

/**
 * Running as an installed app. Chromium reserves no keys in app windows
 * (`BrowserCommandController::IsReservedCommandOrKey` returns early), so the page gets Ctrl+N, Ctrl+T, ⌘N and the
 * rest that a tab never sees.
 */
export const IS_APP =
  typeof matchMedia !== "undefined" &&
  ["standalone", "window-controls-overlay", "minimal-ui"].some((mode) => matchMedia(`(display-mode: ${mode})`).matches);

interface Keys {
  mac: string;
  other: string;
  /** The familiar key a browser tab keeps for itself: the one shown, and bound, in the installed app. */
  app?: { mac?: string; other?: string };
  /** More keys that do the same, never shown (⌥⌘+ typed with or without Shift). */
  also?: { mac?: readonly string[]; other?: readonly string[] };
}

/**
 * Formatting shortcuts, in ProseMirror key notation ("Mod" is ⌘ on a Mac, Ctrl elsewhere). They are the familiar
 * standard ones, except where a browser tab keeps the key: then the familiar one is `app` and a tab uses the key
 * beside it. Strikethrough on Windows is Ctrl+T in the app and Ctrl+Shift+S in a tab; indent on a Mac is ⇧⌘] in the
 * app and Tab in a tab. On Windows, inline code leaves Ctrl+E to Align center.
 */
const SHORTCUTS = {
  undo: { mac: "Mod-z", other: "Mod-z" },
  redo: { mac: "Shift-Mod-z", other: "Mod-y" },
  paragraph: { mac: "Mod-Alt-0", other: "Mod-Alt-0" },
  heading1: { mac: "Mod-Alt-1", other: "Mod-Alt-1" },
  heading2: { mac: "Mod-Alt-2", other: "Mod-Alt-2" },
  heading3: { mac: "Mod-Alt-3", other: "Mod-Alt-3" },
  bold: { mac: "Mod-b", other: "Mod-b" },
  italic: { mac: "Mod-i", other: "Mod-i" },
  underline: { mac: "Mod-u", other: "Mod-u" },
  strike: { mac: "Ctrl-Mod-k", other: "Mod-Shift-s", app: { other: "Mod-t" } },
  superscript: { mac: "Ctrl-Mod-=", other: "Mod-Shift-ArrowUp", also: { mac: ["Shift-Ctrl-Mod-="] } },
  subscript: { mac: "Ctrl-Mod--", other: "Mod-Shift-ArrowDown" },
  highlight: { mac: "Ctrl-Mod-h", other: "Mod-Shift-h" },
  bulletList: { mac: "Shift-Mod-u", other: "Mod-Shift-b" },
  orderedList: { mac: "Shift-Mod-o", other: "Mod-Shift-o" },
  taskList: { mac: "Shift-Mod-c", other: "Mod-Shift-c" },
  indent: { mac: "Tab", other: "Mod-m", app: { mac: "Shift-Mod-]" } },
  outdent: { mac: "Shift-Tab", other: "Mod-Shift-m", app: { mac: "Shift-Mod-[" } },
  alignLeft: { mac: "Shift-Alt-Mod-[", other: "Mod-l" },
  alignCenter: { mac: "Alt-Mod-=", other: "Mod-e", also: { mac: ["Shift-Alt-Mod-="] } },
  alignRight: { mac: "Shift-Alt-Mod-]", other: "Mod-j" },
  justify: { mac: "Alt-Mod--", other: "Mod-q" },
  link: { mac: "Mod-k", other: "Mod-k" },
  removeLink: { mac: "Shift-Mod-k", other: "Mod-Shift-k" },
  code: { mac: "Mod-e", other: "Mod-Shift-e" },
  codeBlock: { mac: "Ctrl-Mod-b", other: "Mod-Shift-l" },
  horizontalRule: { mac: "Shift-Mod-h", other: "Mod-Shift--" },
  insertDate: { mac: "Shift-Mod-d", other: "Alt-Shift-d" },
  insertTime: { mac: "Shift-Alt-Mod-d", other: "Mod-Shift-d" },
  // The familiar Mac key, ⇧Space, would swallow every space typed with Shift held, so a Mac has none.
  simplifyFormatting: { mac: "", other: "Mod-Space" },
  clearFormatting: { mac: "Shift-Mod-Space", other: "Mod-Shift-Space" },
} as const satisfies Record<string, Keys>;

export type ShortcutName = keyof typeof SHORTCUTS;

export const SHORTCUT_NAMES = Object.keys(SHORTCUTS) as ShortcutName[];

const side = (mac: boolean) => (mac ? "mac" : "other");

/** The key shown for a shortcut: the familiar one in the installed app where a tab can't have it. "" when none. */
export function shortcutKeys(name: ShortcutName, mac = IS_MAC, app = IS_APP): string {
  const keys: Keys = SHORTCUTS[name];
  return (app ? keys.app?.[side(mac)] : undefined) ?? keys[side(mac)];
}

/** The key a browser tab keeps for itself, which the installed app uses instead. */
export function appOnlyKeys(name: ShortcutName, mac = IS_MAC): string | undefined {
  const keys: Keys = SHORTCUTS[name];
  return keys.app?.[side(mac)];
}

/**
 * Every key that runs the shortcut, shown one first. The editor binds all of them everywhere: a tab never delivers
 * the app-only ones, so binding them there costs nothing.
 */
export function shortcutBindings(name: ShortcutName, mac = IS_MAC, app = IS_APP): string[] {
  const keys: Keys = SHORTCUTS[name];
  const all = [shortcutKeys(name, mac, app), keys[side(mac)], keys.app?.[side(mac)], ...(keys.also?.[side(mac)] ?? [])];
  return [...new Set(all.filter((k): k is string => !!k))];
}

const MAC_SYMBOL: Record<string, string> = { Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Mod: "⌘", Meta: "⌘" };
const MAC_ORDER = ["Ctrl", "Alt", "Shift", "Mod", "Meta"];
const OTHER_ORDER = ["Mod", "Ctrl", "Alt", "Shift"];

/** How the shortcut is written in tooltips and menus: "⇧⌘C" on a Mac, "Ctrl+Shift+C" elsewhere. "" when none. */
export function shortcutLabel(name: ShortcutName, mac = IS_MAC, app = IS_APP): string {
  const keys = shortcutKeys(name, mac, app);
  if (!keys) return "";
  const parts = keys.split(/-(?!$)/);
  const key = parts.pop() ?? "";
  const shown = key.length === 1 ? key.toUpperCase() : key;
  const mods = new Set(parts);
  if (mac)
    return `${MAC_ORDER.filter((m) => mods.has(m))
      .map((m) => MAC_SYMBOL[m])
      .join("")}${shown}`;
  return [...OTHER_ORDER.filter((m) => mods.has(m)).map((m) => (m === "Mod" ? "Ctrl" : m)), shown].join("+");
}
