// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import { createEditorExtensions } from "./extensions.ts";
import { replaceTextRanges } from "./find.ts";

const editors: Editor[] = [];
afterEach(() => {
  for (const e of editors.splice(0)) e.destroy();
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

function find(editor: Editor, text: string): { from: number; to: number } {
  let found = { from: -1, to: -1 };
  editor.state.doc.descendants((node, pos) => {
    const at = node.isText ? (node.text ?? "").indexOf(text) : -1;
    if (found.from < 0 && at >= 0) found = { from: pos + at, to: pos + at + text.length };
    return found.from < 0;
  });
  return found;
}

describe("replacing found text", () => {
  it("keeps a link on text replaced at the link's end", () => {
    const editor = load('<p>Read <a href="https://example.org/a">the page</a> now</p>');
    expect(replaceTextRanges(editor, [find(editor, "page")], "site")).toBe(1);
    expect(editor.getHTML()).toMatch(/<a [^>]*href="https:\/\/example.org\/a"[^>]*>the site<\/a> now/);
  });

  it("skips a range that crosses blocks, and deletes when the replacement is empty", () => {
    const editor = load("<p>one</p><p>two</p>");
    const one = find(editor, "one");
    const two = find(editor, "two");
    expect(replaceTextRanges(editor, [{ from: one.from, to: two.to }], "x")).toBe(0);
    expect(replaceTextRanges(editor, [two], "")).toBe(1);
    expect(editor.getText()).toBe("one\n\n");
  });

  it("is its own undo step, apart from typing just before it", () => {
    const editor = load("<p>cat</p>");
    editor.commands.insertContentAt(1, "a ");
    replaceTextRanges(editor, [find(editor, "cat")], "dog");
    editor.commands.undo();
    expect(editor.getText()).toBe("a cat");
  });
});
