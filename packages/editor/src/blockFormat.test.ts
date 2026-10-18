// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import { indentSteps, parseAlignment } from "./blockFormat.ts";
import { compactDoc } from "./content.ts";
import { createEditorExtensions } from "./extensions.ts";

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

describe("schema v3 block formatting", () => {
  it("indents paragraphs a step at a time, up to 8, and lists by nesting", () => {
    const e = load("<p>a</p><ul><li><p>one</p></li><li><p>two</p></li></ul>");
    e.commands.setTextSelection(1);
    expect(e.commands.indent()).toBe(true);
    expect(e.getJSON().content?.[0]?.attrs?.indent).toBe(1);
    for (let i = 0; i < 10; i++) e.commands.indent();
    expect(e.getJSON().content?.[0]?.attrs?.indent).toBe(8);
    for (let i = 0; i < 10; i++) e.commands.outdent();
    expect(compactDoc(e.getJSON()).content?.[0]).toEqual({ type: "paragraph", content: [{ type: "text", text: "a" }] });
    expect(e.commands.outdent()).toBe(false);
    // In the second list item, indent nests it under the first instead of indenting the paragraph.
    const pos = e.state.doc.content.size - 4;
    e.commands.setTextSelection(pos);
    e.commands.indent();
    const list = e.getJSON().content?.[1];
    expect(list?.content).toHaveLength(1);
    expect(JSON.stringify(compactDoc(list ?? {}))).not.toContain('"indent"');
  });

  it("aligns, and stores left as nothing", () => {
    const e = load("<p>a</p><h2>t</h2>");
    e.commands.selectAll();
    e.commands.setTextAlign("center");
    expect(e.getJSON().content?.map((n) => n.attrs?.textAlign)).toEqual(["center", "center"]);
    e.commands.setTextAlign("left");
    expect(compactDoc(e.getJSON()).content?.map((n) => n.attrs?.textAlign ?? null)).toEqual([null, null]);
  });

  it("keeps alignment, indent and sub/superscript from pasted HTML", () => {
    const e = load('<p style="text-align: right; margin-left: 80px">x<sub>2</sub><sup>n</sup></p>');
    const p = e.getJSON().content?.[0];
    expect(p?.attrs).toMatchObject({ textAlign: "right", indent: 2 });
    expect(p?.content?.map((t) => t.marks?.[0]?.type ?? null)).toEqual([null, "subscript", "superscript"]);
  });

  it("toggles subscript and superscript, one excluding the other", () => {
    const e = load("<p>x2</p>");
    e.commands.setTextSelection({ from: 2, to: 3 });
    e.commands.toggleSuperscript();
    e.commands.toggleSubscript();
    expect(e.getJSON().content?.[0]?.content?.[1]?.marks).toEqual([{ type: "subscript" }]);
  });

  it("reads CSS lengths and alignments the way Evernote writes them", () => {
    expect(indentSteps("40px")).toBe(1);
    expect(indentSteps("30pt")).toBe(1);
    expect(indentSteps("5em")).toBe(2);
    expect(indentSteps("0px")).toBe(0);
    expect(indentSteps("auto")).toBe(0);
    expect(parseAlignment("END")).toBe("right");
    expect(parseAlignment("start")).toBeNull();
  });
});
