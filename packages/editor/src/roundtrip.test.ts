// @vitest-environment jsdom
import { Editor, type JSONContent } from "@tiptap/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeColor } from "./colors.ts";
import { compactDoc, migrateContent, toNoteContent } from "./content.ts";
import { checkDoc, createEditorExtensions, getEditorSchema, SCHEMA_VERSION } from "./extensions.ts";
import { bigTableDoc, bigWebClipDoc, everyFeatureDoc, v1Doc } from "./fixtures.ts";
import { SANITIZER_VERSION } from "./sanitize.ts";

const editors: Editor[] = [];
afterEach(() => {
  for (const e of editors.splice(0)) e.destroy();
});

function load(content: JSONContent | string): Editor {
  const editor = new Editor({ element: document.createElement("div"), extensions: createEditorExtensions(), content });
  editors.push(editor);
  return editor;
}

// Every key the fixture states must come back with the same value (defaults the schema adds are allowed).
function expectSubset(actual: unknown, expected: unknown, path = "doc"): void {
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual), path).toBe(true);
    expect((actual as unknown[]).length, `${path}.length`).toBe(expected.length);
    expected.forEach((v, i) => {
      expectSubset((actual as unknown[])[i], v, `${path}[${i}]`);
    });
  } else if (expected && typeof expected === "object") {
    expect(actual && typeof actual === "object", path).toBe(true);
    for (const [k, v] of Object.entries(expected))
      expectSubset((actual as Record<string, unknown>)[k], v, `${path}.${k}`);
  } else {
    expect(actual, path).toEqual(expected);
  }
}

function nodeTypes(doc: JSONContent, out = new Set<string>()): Set<string> {
  out.add(doc.type ?? "?");
  for (const m of doc.marks ?? []) out.add(`mark:${m.type}`);
  for (const c of doc.content ?? []) nodeTypes(c, out);
  return out;
}

describe("every-feature fixture", () => {
  it("covers every node and mark in the schema", () => {
    const schema = getEditorSchema();
    const seen = nodeTypes(everyFeatureDoc);
    for (const name of Object.keys(schema.nodes)) expect(seen, `node ${name}`).toContain(name);
    for (const name of Object.keys(schema.marks)) expect(seen, `mark ${name}`).toContain(`mark:${name}`);
  });

  it("is valid against the schema", () => {
    expect(() => getEditorSchema().nodeFromJSON(everyFeatureDoc).check()).not.toThrow();
  });
});

describe("JSON → editor → JSON", () => {
  it("is lossless for every node and mark", () => {
    const out = load(everyFeatureDoc).getJSON();
    expectSubset(out, everyFeatureDoc);
    expect(out).toEqual(getEditorSchema().nodeFromJSON(everyFeatureDoc).toJSON());
  });

  it("is stable when the output is loaded again", () => {
    const once = load(everyFeatureDoc).getJSON();
    expect(load(once).getJSON()).toEqual(once);
  });

  it("does not touch a document that ends in a table (no trailing paragraph added)", () => {
    const doc: JSONContent = { type: "doc", content: [bigTableDoc(2, 2).content?.[1] as JSONContent] };
    const out = load(doc).getJSON();
    expect(out.content).toHaveLength(1);
    expect(out.content?.[0]?.type).toBe("table");
  });

  it("keeps a large web clip byte-for-byte", () => {
    const doc = bigWebClipDoc(300_000);
    const out = load(doc).getJSON();
    expect(out.content?.[1]?.attrs?.html).toBe(doc.content?.[1]?.attrs?.html);
  });
});

describe("JSON → HTML → JSON (clipboard path)", () => {
  it("is lossless for every node and mark", () => {
    const source = load(everyFeatureDoc).getJSON();
    const html = load(everyFeatureDoc).getHTML();
    expect(load(html).getJSON()).toEqual(source);
  });

  it("stores pasted colors in one canonical form", () => {
    const out = load(
      '<p><span style="color: RGB(176, 58, 46)">a</span><mark style="background-color: #FA0">b</mark></p>',
    ).getJSON();
    const [a, b] = out.content?.[0]?.content ?? [];
    expect(a?.marks?.[0]?.attrs?.color).toBe("#b03a2e");
    expect(b?.marks?.[0]?.attrs?.color).toBe("#ffaa00");
  });

  it("never renders a style value that could escape its declaration", () => {
    const html = load({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "x", marks: [{ type: "textStyle", attrs: { color: "red; background: url(x)" } }] },
          ],
        },
      ],
    }).getHTML();
    expect(html).not.toContain("url(");
  });
});

const json = (editor: Editor): JSONContent => editor.getJSON();

describe("schema v2 nodes and attributes", () => {
  it("round-trips images and Evernote Task attributes through HTML as data attributes", () => {
    const html = load(everyFeatureDoc).getHTML();
    expect(html).toContain(
      '<img src="https://example.org/harbor.png" alt="Harbor at dusk" width="240" height="160" referrerpolicy="no-referrer" loading="lazy">',
    );
    expect(html).toMatch(
      /<li data-checked="false" data-task-id="4f1d2c3b-0000-4000-8000-00000000000a" data-due="2026-11-02T09:00:00.000Z" data-flagged="true" data-type="taskItem">/,
    );
    expect(html).toContain('data-sanitizer-version="1"');
    // A plain checkbox renders no task attributes at all.
    expect(html).toContain('<li data-checked="true" data-type="taskItem"><label>');
    const items = json(load(html)).content?.find((n) => n.content?.[0]?.attrs?.taskId)?.content ?? [];
    expect(items.map((i) => i.attrs)).toEqual([
      {
        checked: false,
        taskId: "4f1d2c3b-0000-4000-8000-00000000000a",
        due: "2026-11-02T09:00:00.000Z",
        flagged: true,
      },
      { checked: true, taskId: "4f1d2c3b-0000-4000-8000-00000000000b", due: null, flagged: false },
    ]);
  });

  it("keeps pasted web images and drops ones it can't show", () => {
    const out = json(
      load(
        '<p>a <img src="https://example.org/x.png" alt="X" width="50" height="20px"> b <img src="local.png"> <img src="javascript:alert(1)"> <img src="data:image/png;base64,iVBORw0KGgo="></p>',
      ),
    );
    const images = out.content?.[0]?.content?.filter((n) => n.type === "image").map((n) => n.attrs);
    expect(images).toEqual([
      { src: "https://example.org/x.png", alt: "X", width: 50, height: 20 },
      { src: "data:image/png;base64,iVBORw0KGgo=", alt: null, width: null, height: null },
    ]);
  });

  it("rejects attribute values of the wrong type", () => {
    const bad = (attrs: Record<string, unknown>): JSONContent => ({
      type: "doc",
      content: [{ type: "taskList", content: [{ type: "taskItem", attrs, content: [{ type: "paragraph" }] }] }],
    });
    expect(checkDoc(bad({ checked: false, flagged: "yes" }))).toMatch(/flagged/);
    expect(checkDoc(bad({ checked: false, taskId: 7 }))).toMatch(/taskId/);
    expect(checkDoc(bad({ checked: false, taskId: "t", due: "2026-01-01T00:00:00.000Z", flagged: true }))).toBeNull();
  });

  it("does not copy an Evernote Task's id, due date or flag into the item Enter creates", () => {
    const editor = load({
      type: "doc",
      content: [
        {
          type: "taskList",
          content: [
            {
              type: "taskItem",
              attrs: { checked: false, taskId: "t1", due: "2026-01-01T00:00:00.000Z", flagged: true },
              content: [{ type: "paragraph", content: [{ type: "text", text: "task" }] }],
            },
          ],
        },
      ],
    });
    editor.commands.setTextSelection(6);
    editor.commands.splitListItem("taskItem");
    const items = json(editor).content?.[0]?.content ?? [];
    expect(items.map((i) => i.attrs)).toEqual([
      { checked: false, taskId: "t1", due: "2026-01-01T00:00:00.000Z", flagged: true },
      { checked: false, taskId: null, due: null, flagged: false },
    ]);
  });
});

describe("v1 notes in the current editor", () => {
  it("load, and save back unchanged once compacted", () => {
    const { doc } = migrateContent({ schema_version: 1, doc: v1Doc });
    expect(checkDoc(doc)).toBeNull();
    expect(compactDoc(load(doc).getJSON())).toEqual(v1Doc);
    expect(compactDoc(load(load(doc).getHTML()).getJSON())).toEqual(v1Doc);
    expect(toNoteContent(load(doc).getJSON())).toEqual({ schema_version: SCHEMA_VERSION, doc: v1Doc });
  });
});

describe("web clip commands", () => {
  it("inserts a pasted page as a sanitized clip stamped with the sanitizer version", () => {
    const editor = load("<p>before</p>");
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    editor.commands.insertWebClip('<div onclick="x()"><p>Page</p><script>bad()</script></div>');
    const clip = json(editor).content?.find((n) => n.type === "webClip");
    expect(clip?.attrs?.sanitizerVersion).toBe(SANITIZER_VERSION);
    expect(clip?.attrs?.html).toBe("<div><p>Page</p></div>");
  });

  it("inserts plain text one paragraph per line without parsing markup", () => {
    const editor = load("<p></p>");
    editor.commands.insertPlainText("one <b>two</b>\r\n\nthree");
    expect(json(editor).content?.map((n) => n.content?.[0]?.text ?? "")).toEqual(["one <b>two</b>", "", "three"]);
  });

  it("keeps images and resource placeholders when converting a clip to editable text", () => {
    const html =
      '<p>Intro <img src="https://example.org/a.png" alt="A" width="10"> <img data-resource-id="r1" alt="scan.png" width="300" height="200"> <span data-resource-id="r2" data-mime="application/pdf">[report.pdf]</span></p>';
    for (const sanitizerVersion of [null, SANITIZER_VERSION]) {
      const editor = load({ type: "doc", content: [{ type: "webClip", attrs: { html, sanitizerVersion } }] });
      expect(editor.commands.convertWebClipToEditable(0)).toBe(true);
      const inline = json(editor).content?.[0]?.content ?? [];
      expect(inline.filter((n) => n.type !== "text")).toEqual([
        { type: "image", attrs: { src: "https://example.org/a.png", alt: "A", width: 10, height: null } },
        {
          type: "attachment",
          attrs: { resourceId: "r1", display: "inline", mime: null, filename: "scan.png", width: 300, height: 200 },
        },
        {
          type: "attachment",
          attrs: {
            resourceId: "r2",
            display: "card",
            mime: "application/pdf",
            filename: "report.pdf",
            width: null,
            height: null,
          },
        },
      ]);
    }
  });
});

describe("normalizeColor", () => {
  it.each([
    ["rgb(176, 58, 46)", "#b03a2e"],
    ["rgba(0,0,0,1)", "#000000"],
    ["rgb(0 128 255 / 100%)", "#0080ff"],
    ["rgba(0, 0, 0, 0.5)", "rgba(0, 0, 0, 0.5)"],
    ["#ABC", "#aabbcc"],
    ["'Red'", "red"],
    ["", null],
  ])("%s → %s", (input, expected) => {
    expect(normalizeColor(input)).toBe(expected);
  });
});

describe("content the schema doesn't know", () => {
  const future: JSONContent = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "before" }] },
      { type: "futureNode", attrs: { x: 1 } },
      { type: "paragraph", content: [{ type: "text", text: "after", marks: [{ type: "futureMark" }] }] },
    ],
  };

  it("is reported by checkDoc", () => {
    expect(checkDoc(future)).toMatch(/futureNode/);
    expect(
      checkDoc({
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "futureMark" }] }] }],
      }),
    ).toMatch(/futureMark/);
    expect(checkDoc(everyFeatureDoc)).toBeNull();
  });

  it("is silently replaced by an empty document in Tiptap (why checkDoc must gate opening and saving)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(compactDoc(load(future).getJSON())).toEqual({ type: "doc", content: [{ type: "paragraph" }] });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("editing behavior", () => {
  it("does not extend a link when typing right after it", () => {
    const editor = load('<p>see <a href="https://a.example">site</a></p>');
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    editor.view.dispatch(editor.state.tr.insertText("X"));
    const runs = editor.getJSON().content?.[0]?.content ?? [];
    expect(runs.at(-1)).toEqual({ type: "text", text: "X" });
  });

  it("drops hostile markup on paste and keeps the text", () => {
    // jsdom has no ClipboardEvent; ProseMirror only constructs one to pass along.
    (globalThis as { ClipboardEvent?: unknown }).ClipboardEvent ??= class extends Event {};
    const editor = load("<p></p>");
    editor.view.pasteHTML(
      '<p onclick="alert(1)">Hi <a href="javascript:alert(2)">bad</a> <a href="https://ok.example">good</a></p><script>alert(3)</script><img src="x" onerror="alert(4)"><iframe src="https://a.example"></iframe>',
    );
    const json = JSON.stringify(editor.getJSON());
    expect(json).not.toMatch(/javascript:|alert|onclick|iframe|script/);
    expect(json).toContain("https://ok.example");
    expect(editor.getText()).toContain("Hi bad good");
  });
});
