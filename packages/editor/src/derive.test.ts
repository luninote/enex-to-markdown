import type { JSONContent } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { docFlags, docSnippet, docToPlainText, fileKind } from "./derive.ts";
import { bigWebClipDoc, everyFeatureDoc, manyParagraphsDoc } from "./fixtures.ts";
import { htmlToText } from "./htmlText.ts";

const doc = (...content: JSONContent[]): JSONContent => ({ type: "doc", content });
const p = (text?: string): JSONContent =>
  text ? { type: "paragraph", content: [{ type: "text", text }] } : { type: "paragraph" };

describe("runs without a DOM", () => {
  it("has no document global here", () => {
    expect(typeof (globalThis as { document?: unknown }).document).toBe("undefined");
  });
});

describe("docToPlainText", () => {
  it("puts one text block per line, hard breaks as newlines", () => {
    const text = docToPlainText(everyFeatureDoc);
    const lines = text.split("\n");
    expect(lines.slice(0, 2)).toEqual(["Trip planning", "Level two"]);
    expect(text).toContain("Plain, bold, italic, underline, strike, code.");
    expect(text).toContain("A highlighted bold link run then red serif 18px.");
    expect(text).toContain("Line one\nline two\n\nafter two breaks");
    expect(text).toContain("Passport\nCheck expiry\nDeep item\nTickets");
    expect(text).toContain("Book hotel\nPack bags\nChargers");
    expect(text).toContain("def hello():\n    return 42");
  });

  it("writes table rows as tab-separated cells", () => {
    const text = docToPlainText(everyFeatureDoc);
    expect(text).toContain("Merged header\tCost\nTall cell\tFlight\t420\nHotel\t");
  });

  it("includes clip and unsupported text, but not ciphertext, hints, attachment names or image alt text", () => {
    const text = docToPlainText(everyFeatureDoc);
    expect(text).toContain("Clipped article\nSome clipped text with a link.");
    expect(text).toContain("kept as is");
    expect(text).toContain("Renew passport\nOrder currency");
    expect(text).toContain("Linked web image  and a bare one ");
    expect(text).not.toContain("RU5DMA");
    expect(text).not.toContain("the usual");
    expect(text).not.toContain("map.png");
    expect(text).not.toMatch(/Harbor at dusk|harbor\.png/);
  });

  it("handles an empty document", () => {
    expect(docToPlainText(doc(p()))).toBe("");
  });

  it("is fast enough for a 20k-paragraph note", () => {
    const big = manyParagraphsDoc(20000);
    const t0 = performance.now();
    const text = docToPlainText(big);
    expect(text.split("\n")).toHaveLength(20000);
    expect(performance.now() - t0).toBeLessThan(1500);
  });

  it("extracts text from a 5 MB clip", () => {
    const text = docToPlainText(bigWebClipDoc());
    expect(text).toContain("Section 1: notes on the harbor survey");
    expect(text).not.toMatch(/<|data:image/);
  });
});

describe("htmlToText", () => {
  it("drops scripts, styles and svg, decodes entities, breaks on blocks", () => {
    expect(
      htmlToText(
        "<style>p{}</style><p>Fish &amp; chips&nbsp;&#8364;5 &#x1F600;</p><script>x()</script><div>Next<br>line</div><svg><text>no</text></svg>",
      ),
    ).toBe("Fish & chips €5 😀\nNext\nline");
  });
});

describe("docSnippet", () => {
  it("collapses whitespace and keeps short text intact", () => {
    expect(docSnippet(doc(p("Hello"), p("  world  ")))).toBe("Hello world");
  });

  it("never exceeds the limit and cuts at a nearby word boundary", () => {
    const words = Array.from({ length: 100 }, (_, i) => `word${i}`).join(" ");
    const s = docSnippet(doc(p(words)), 200);
    expect(s.length).toBeLessThanOrEqual(200);
    expect(words.startsWith(s)).toBe(true);
    expect(words[s.length]).toBe(" ");
  });

  it("counts emoji as one character and never splits them", () => {
    const s = docSnippet(doc(p("👩‍👩‍👧".repeat(300))), 200);
    expect([...new Intl.Segmenter().segment(s)]).toHaveLength(200);
  });

  it("cuts CJK text without spaces hard at the limit", () => {
    const s = docSnippet(doc(p("日本語の文章".repeat(100))), 200);
    expect(s).toHaveLength(200);
  });
});

describe("docFlags", () => {
  it("detects everything in the every-feature doc", () => {
    expect(docFlags(everyFeatureDoc)).toEqual({
      todo: true,
      todoChecked: true,
      todoUnchecked: true,
      task: true,
      taskCompleted: true,
      taskNotCompleted: true,
      list: true,
      table: true,
      codeBlock: true,
      attachment: true,
      fileKinds: ["image", "pdf"],
      mimes: ["application/pdf", "image/png"],
      webClip: true,
      encrypted: true,
      url: true,
      email: true,
    });
  });

  it("is all false for plain text", () => {
    const f = docFlags(doc(p("Just words, no links.")));
    expect(Object.entries(f).filter(([, v]) => v === true || (Array.isArray(v) && v.length))).toEqual([]);
  });

  it("separates checked and unchecked todos", () => {
    const tasks = (checked: boolean[]): JSONContent =>
      doc({
        type: "taskList",
        content: checked.map((c) => ({ type: "taskItem", attrs: { checked: c }, content: [p("x")] })),
      });
    expect(docFlags(tasks([true, true]))).toMatchObject({ todo: true, todoChecked: true, todoUnchecked: false });
    expect(docFlags(tasks([false]))).toMatchObject({ todo: true, todoChecked: false, todoUnchecked: true });
  });

  it("tells Evernote Tasks (with a taskId) apart from plain checkboxes", () => {
    const item = (checked: boolean, taskId: string | null): JSONContent => ({
      type: "taskItem",
      attrs: { checked, taskId },
      content: [p("x")],
    });
    const list = (...items: JSONContent[]) => doc({ type: "taskList", content: items });
    expect(docFlags(list(item(false, "t1"), item(true, "t2")))).toMatchObject({
      todo: false,
      todoChecked: false,
      todoUnchecked: false,
      task: true,
      taskCompleted: true,
      taskNotCompleted: true,
    });
    expect(docFlags(list(item(true, null)))).toMatchObject({ todo: true, todoChecked: true, task: false });
    expect(docFlags(list(item(false, "t1"), item(true, null)))).toMatchObject({
      todo: true,
      todoChecked: true,
      todoUnchecked: false,
      task: true,
      taskCompleted: false,
      taskNotCompleted: true,
    });
  });

  it("finds URLs in link marks, plain text and clips", () => {
    const linked: JSONContent = doc({
      type: "paragraph",
      content: [{ type: "text", text: "here", marks: [{ type: "link", attrs: { href: "https://a.example" } }] }],
    });
    expect(docFlags(linked).url).toBe(true);
    expect(docFlags(doc(p("see https://a.example/x"))).url).toBe(true);
    expect(docFlags(doc({ type: "webClip", attrs: { html: '<a href="http://a.example">x</a>' } })).url).toBe(true);
    expect(docFlags(doc({ type: "webClip", attrs: { html: "<p>no links</p>" } })).url).toBe(false);
  });

  it("maps MIME types to file kinds", () => {
    expect(fileKind("image/jpeg")).toBe("image");
    expect(fileKind("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBe("spreadsheet");
    expect(fileKind("application/vnd.openxmlformats-officedocument.presentationml.presentation")).toBe("presentation");
    expect(fileKind("application/msword")).toBe("document");
    expect(fileKind("application/zip")).toBe("archive");
    expect(fileKind(null)).toBe("other");
  });

  it("rejects documents that do not match the schema", () => {
    expect(() => docFlags({ type: "doc", content: [{ type: "nope" }] })).toThrow();
  });
});
