// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEditorExtensions } from "./extensions.ts";
import { dateStamp, shortcutBindings, shortcutLabel } from "./shortcuts.ts";

const editors: Editor[] = [];
afterEach(() => {
  for (const e of editors.splice(0)) e.destroy();
  vi.useRealTimers();
});
const load = (html: string) => {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: createEditorExtensions(),
    content: html,
  });
  editors.push(editor);
  return editor;
};

/** A keydown as the editor's keymap sees it (jsdom is not a Mac, so Mod is Ctrl). */
function press(editor: Editor, key: string, mods: { ctrl?: boolean; alt?: boolean; shift?: boolean } = {}) {
  const code = /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : key === " " ? "Space" : key;
  const keyCode = /^[a-z]$/i.test(key) ? key.toUpperCase().charCodeAt(0) : 0;
  const event = new KeyboardEvent("keydown", {
    key: mods.shift && key.length === 1 ? key.toUpperCase() : key,
    code,
    keyCode,
    ctrlKey: !!mods.ctrl,
    altKey: !!mods.alt,
    shiftKey: !!mods.shift,
    bubbles: true,
    cancelable: true,
  });
  return editor.view.someProp("handleKeyDown", (f) => f(editor.view, event)) ?? false;
}

describe("familiar editor keys", () => {
  it("shows the key a tab can have, and the familiar one in the installed app", () => {
    expect(shortcutLabel("strike", false, false)).toBe("Ctrl+Shift+S");
    expect(shortcutLabel("strike", false, true)).toBe("Ctrl+T");
    expect(shortcutLabel("indent", true, true)).toBe("⇧⌘]");
    expect(shortcutLabel("simplifyFormatting", true)).toBe("");
    // Both are bound everywhere: a tab never delivers Ctrl+T, so it costs nothing there.
    expect(shortcutBindings("strike", false, false)).toEqual(["Mod-Shift-s", "Mod-t"]);
  });

  it("centres with Ctrl+E on Windows, leaving inline code to Ctrl+Shift+E", () => {
    const e = load("<p>abc</p>");
    e.commands.setTextSelection({ from: 1, to: 4 });
    expect(press(e, "e", { ctrl: true })).toBe(true);
    expect(e.getJSON().content?.[0]?.attrs?.textAlign).toBe("center");
    expect(e.isActive("code")).toBe(false);
    press(e, "e", { ctrl: true, shift: true });
    expect(e.isActive("code")).toBe(true);
    press(e, "l", { ctrl: true });
    expect(e.getJSON().content?.[0]?.attrs?.textAlign ?? null).toBe(null);
  });

  it("inserts the date and the time where the cursor is", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 14, 15, 42));
    const e = load("<p>x</p>");
    e.commands.setTextSelection(2);
    press(e, "d", { alt: true, shift: true });
    e.commands.insertContent(" ");
    press(e, "d", { ctrl: true, shift: true });
    expect(e.getText()).toBe(`x${dateStamp("date")} ${dateStamp("time")}`);
  });

  it("simplifies formatting: colors and highlights go, bold and links stay", () => {
    const e = load(
      '<p><a href="https://example.org"><strong><mark data-color="#fbe3a1"><span style="color: #a1251b">t</span></mark></strong></a></p>',
    );
    e.commands.selectAll();
    press(e, " ", { ctrl: true });
    const marks = e.getJSON().content?.[0]?.content?.[0]?.marks?.map((m) => m.type);
    expect(marks?.sort()).toEqual(["bold", "link"]);
  });
});
