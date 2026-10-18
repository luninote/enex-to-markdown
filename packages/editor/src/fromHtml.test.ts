// @vitest-environment jsdom
import type { JSONContent } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { toNoteContent } from "./content.ts";
import { checkDoc, getEditorSchema } from "./extensions.ts";
import { type HtmlResource, htmlToDoc } from "./fromHtml.ts";

function find(doc: JSONContent, type: string): JSONContent[] {
  const out: JSONContent[] = [];
  const walk = (n: JSONContent) => {
    if (n.type === type) out.push(n);
    for (const c of n.content ?? []) walk(c);
  };
  walk(doc);
  return out;
}

const marksOf = (doc: JSONContent, text: string) =>
  find(doc, "text")
    .find((t) => t.text === text)
    ?.marks?.map((m) => m.type) ?? [];

describe("htmlToDoc", () => {
  it("keeps headings, paragraphs, lists, quotes, code and basic marks", () => {
    const doc = htmlToDoc(
      "<h2>Soup</h2><p>A <b>bold</b> and <em>calm</em> start.</p><ul><li>one</li><li>two<ol><li>nested</li></ol></li></ul><blockquote><p>quoted</p></blockquote><pre><code>let x = 1;</code></pre><hr>",
    );
    expect(checkDoc(doc)).toBeNull();
    expect(find(doc, "heading")[0]?.attrs?.level).toBe(2);
    expect(find(doc, "bulletList")).toHaveLength(1);
    expect(find(doc, "orderedList")).toHaveLength(1);
    expect(find(doc, "listItem")).toHaveLength(3);
    expect(find(doc, "blockquote")).toHaveLength(1);
    expect(find(doc, "codeBlock")[0]?.content?.[0]?.text).toBe("let x = 1;");
    expect(find(doc, "horizontalRule")).toHaveLength(1);
    expect(marksOf(doc, "bold")).toEqual(["bold"]);
    expect(marksOf(doc, "calm")).toEqual(["italic"]);
  });

  it("turns stored pictures into attachments and keeps other web pictures as images", () => {
    const resources = new Map<string, HtmlResource>([
      [
        "https://example.org/a/cat.png",
        { resourceId: "0190a8f2-0000-7000-8000-000000000001", mime: "image/png", width: 640, height: 480 },
      ],
    ]);
    const doc = htmlToDoc(
      '<p>Before <img src="cat.png" alt="A cat"> after</p><p><img src="https://cdn.example.org/dog.jpg" alt="A dog" width="300"></p><p><img src="blob:https://example.org/x"><img src="file:///c/x.png"></p>',
      { baseUrl: "https://example.org/a/page.html", resources },
    );
    expect(checkDoc(doc)).toBeNull();
    const [att] = find(doc, "attachment");
    expect(att?.attrs).toMatchObject({
      resourceId: "0190a8f2-0000-7000-8000-000000000001",
      mime: "image/png",
      filename: "A cat",
      display: "inline",
      width: 640,
      height: 480,
    });
    const images = find(doc, "image");
    expect(images).toHaveLength(1);
    expect(images[0]?.attrs).toMatchObject({ src: "https://cdn.example.org/dog.jpg", alt: "A dog", width: 300 });
  });

  it("resolves relative links and drops in-page anchors and script links", () => {
    const doc = htmlToDoc(
      '<p><a href="/docs/x">docs</a> <a href="#top">top</a> <a href="javascript:alert(1)">bad</a> <a href="mailto:a@example.org">mail</a></p>',
      { baseUrl: "https://example.org/blog/post" },
    );
    expect(checkDoc(doc)).toBeNull();
    const links = find(doc, "text")
      .flatMap((t) => t.marks ?? [])
      .filter((m) => m.type === "link")
      .map((m) => m.attrs?.href);
    expect(links).toEqual(["https://example.org/docs/x", "mailto:a@example.org"]);
    expect(marksOf(doc, "top")).toEqual([]);
    expect(marksOf(doc, "bad")).toEqual([]);
  });

  it("keeps tables as tables", () => {
    const doc = htmlToDoc(
      "<table><thead><tr><th>Name</th><th>Qty</th></tr></thead><tbody><tr><td>Flour</td><td>2</td></tr><tr><td colspan='2'>Total</td></tr></tbody></table>",
    );
    expect(checkDoc(doc)).toBeNull();
    expect(find(doc, "table")).toHaveLength(1);
    expect(find(doc, "tableRow")).toHaveLength(3);
    expect(find(doc, "tableHeader")).toHaveLength(2);
    expect(find(doc, "tableCell").at(-1)?.attrs?.colspan).toBe(2);
  });

  it("drops scripts, styles, forms and SVG text, and inline styles unless asked", () => {
    const html =
      '<style>p{color:red}</style><script>alert(1)</script><p style="color:#ff0000">red <font color="blue">blue</font></p><svg><title>icon title</title></svg><form><select><option>opt</option></select><button>Go</button></form>';
    const plain = htmlToDoc(html);
    expect(checkDoc(plain)).toBeNull();
    const text = find(plain, "text")
      .map((t) => t.text)
      .join("");
    expect(text).toBe("red blue");
    expect(find(plain, "text").flatMap((t) => t.marks ?? [])).toEqual([]);
    const styled = htmlToDoc('<p><span style="color:#ff0000">red</span></p>', { keepStyles: true });
    expect(checkDoc(styled)).toBeNull();
    expect(marksOf(styled, "red")).toContain("textStyle");
  });

  it("keeps alignment, indent and sub/superscript where the schema has them (v3)", () => {
    const doc = htmlToDoc(
      '<p style="text-align:center;color:#ff0000">middle</p><p style="margin-left:40px">in</p><p>H<sub>2</sub>O and x<sup>2</sup></p>',
    );
    expect(checkDoc(doc)).toBeNull();
    const schema = getEditorSchema();
    const [centered, indented] = find(doc, "paragraph");
    if (schema.nodes.paragraph?.spec.attrs?.textAlign) expect(centered?.attrs?.textAlign).toBe("center");
    if (schema.nodes.paragraph?.spec.attrs?.indent) expect(indented?.attrs?.indent).toBeGreaterThan(0);
    if (schema.marks.subscript) expect(marksOf(doc, "2")).toContain("subscript");
    expect(
      find(doc, "text")
        .flatMap((t) => t.marks ?? [])
        .some((m) => m.type === "textStyle"),
    ).toBe(false);
  });

  it("always returns a valid document, even for nothing", () => {
    for (const html of ["", "   ", "<script>x</script>", "<div><span></span></div>", "just text"]) {
      const doc = htmlToDoc(html);
      expect(checkDoc(doc)).toBeNull();
      expect(checkDoc(toNoteContent(doc).doc)).toBeNull();
    }
  });
});
