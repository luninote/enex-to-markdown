import { checkDoc, SANITIZER_VERSION, sanitizeClipHtml } from "@luninote/editor";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { NoteLinkResolver } from "../links.ts";
import { CODE_BLOCK_MAX_LINES, type ConvertOptions, type ConvertResult, convertEnml } from "./convert.ts";

type J = { type: string; text?: string; attrs?: Record<string, unknown>; marks?: J[]; content?: J[] };

const win = new JSDOM("").window;
const sanitize = (html: string) => sanitizeClipHtml(html, win as never);

function convert(body: string, opts: ConvertOptions = {}): ConvertResult & { root: J } {
  const res = convertEnml(
    `<?xml version="1.0"?><!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd"><en-note>${body}</en-note>`,
    opts,
  );
  expect(checkDoc(res.doc)).toBeNull();
  return { ...res, root: res.doc as J };
}

/** Compact outline: "paragraph(text|br|text)" style, enough to assert structure without full snapshots. */
function outline(node: J): string {
  if (node.type === "text") return JSON.stringify(node.text);
  if (node.type === "hardBreak") return "br";
  const inner = (node.content ?? []).map(outline).join(" ");
  return inner ? `${node.type}(${inner})` : node.type;
}
const blocks = (r: { root: J }) => (r.root.content ?? []).map(outline);
const codes = (r: ConvertResult) => r.warnings.map((w) => w.code);
function all(node: J, type: string): J[] {
  const out: J[] = [];
  const walk = (n: J) => {
    if (n.type === type) out.push(n);
    for (const c of n.content ?? []) walk(c);
  };
  walk(node);
  return out;
}
const marksOf = (n: J) => Object.fromEntries((n.marks ?? []).map((m) => [m.type, m.attrs ?? {}]));

describe("convertEnml: lines and whitespace", () => {
  it("maps div-per-line content, <br> and bare text the way a browser shows it", () => {
    const r = convert(
      "top<br/>line\n<div>a</div><div><br/></div><div>b<br/></div><div>c<br/><br/></div><div></div><p>d</p>",
    );
    expect(blocks(r)).toEqual([
      'paragraph("top" br "line")',
      'paragraph("a")',
      "paragraph",
      'paragraph("b")',
      'paragraph("c" br)',
      'paragraph("d")',
    ]);
  });

  it("collapses source whitespace but keeps non-breaking spaces and spaces between inline elements", () => {
    const r = convert("<div>\n  one   <b>two</b>\n <i>three</i>&nbsp;&nbsp;four  </div>");
    expect(all(r.root, "text").map((t) => t.text)).toEqual(["one ", "two", " ", "three", "  four"]);
  });

  it("keeps whitespace in white-space: pre blocks", () => {
    const r = convert('<div style="white-space: pre-wrap;">a  b\n  c</div>');
    expect(blocks(r)).toEqual(['paragraph("a  b" br "  c")']);
  });

  it("produces an empty paragraph for an empty note and strips NUL characters", () => {
    expect(blocks(convert(""))).toEqual(["paragraph"]);
    expect(all(convert("<div>a\u0000b</div>").root, "text")[0]?.text).toBe("ab");
  });
});

describe("convertEnml: tasks", () => {
  it("turns en-todo lines into one task list and splits mid-line checkboxes", () => {
    const r = convert(
      '<div><en-todo checked="true"/>done</div><div><en-todo/>open</div><div>intro<br/><en-todo checked="false"/>x <en-todo checked="true"/>y</div>',
    );
    expect(blocks(r)).toEqual([
      'taskList(taskItem(paragraph("done")) taskItem(paragraph("open")))',
      'paragraph("intro")',
      'taskList(taskItem(paragraph("x")) taskItem(paragraph("y")))',
    ]);
    expect(all(r.root, "taskItem").map((t) => t.attrs?.checked)).toEqual([true, false, false, true]);
  });

  it("reads Evernote 10 checklists, nested lists included", () => {
    const r = convert(
      '<ul style="--en-todo:true;"><li style="--en-checked:true;"><div>a</div></li><li style="--en-checked:false;"><div>b</div><ul><li><div>c</div></li></ul></li></ul>',
    );
    expect(blocks(r)).toEqual([
      'taskList(taskItem(paragraph("a")) taskItem(paragraph("b") bulletList(listItem(paragraph("c")))))',
    ]);
    expect(all(r.root, "taskItem").map((t) => t.attrs?.checked)).toEqual([true, false]);
  });

  it("places Evernote Tasks at their task-group block, by sort weight, and appends unplaced ones", () => {
    const tasks = [
      { title: "second", status: "open", sortWeight: "M", groupId: "g1" },
      { title: "first", status: "completed", sortWeight: "C", groupId: "g1" },
      { title: "orphan", status: "open", sortWeight: "A", groupId: "elsewhere" },
    ];
    const r = convert(
      '<div>x</div><div style="--en-task-group:true; --en-id:g1;"><div>Content not supported</div></div><div>y</div>',
      { tasks },
    );
    expect(blocks(r)).toEqual([
      'paragraph("x")',
      'taskList(taskItem(paragraph("first")) taskItem(paragraph("second")))',
      'paragraph("y")',
      'taskList(taskItem(paragraph("orphan")))',
    ]);
    expect(all(r.root, "taskItem")[0]?.attrs?.checked).toBe(true);
    expect(r.stats.tasks).toBe(3);
    expect(codes(r)).toEqual(expect.arrayContaining(["tasks", "tasks_unplaced"]));
  });

  it("maps Evernote Tasks to task items carrying id, due date and flag; checkboxes stay plain", () => {
    const tasks = [
      {
        id: "0cf6ea1a-2aca-446d-9a09-dea60df73226",
        title: "Call the plumber",
        status: "open",
        flag: true,
        dueDate: new Date("2025-05-28T21:59:59Z"),
        sortWeight: "B",
        groupId: "g1",
      },
      { id: null, title: "No id", status: "completed", sortWeight: "C", groupId: "g1" },
      { id: "dup", title: "First", status: "open", sortWeight: "D", groupId: "g1" },
      { id: "dup", title: "Second", status: "open", flag: false, dueDate: null, sortWeight: "E", groupId: "g1" },
    ];
    const r = convert('<div><en-todo/>checkbox</div><div style="--en-task-group:true; --en-id:g1;"></div>', {
      tasks,
    });
    expect(all(r.root, "taskItem").map((t) => t.attrs)).toEqual([
      { checked: false },
      {
        checked: false,
        taskId: "0cf6ea1a-2aca-446d-9a09-dea60df73226",
        due: "2025-05-28T21:59:59.000Z",
        flagged: true,
      },
      { checked: true, taskId: "imported-2" },
      { checked: false, taskId: "dup" },
      { checked: false, taskId: "imported-4" },
    ]);
  });
});

describe("convertEnml: lists, tables, headings, quotes, code", () => {
  it("nests lists, including a <ul> placed directly in a <ul>, and keeps ol start", () => {
    const r = convert('<ol start="3"><li>a</li><ul><li>b</li></ul><li></li></ol>');
    expect(blocks(r)).toEqual([
      'orderedList(listItem(paragraph("a") bulletList(listItem(paragraph("b")))) listItem(paragraph))',
    ]);
    expect(r.root.content?.[0]?.attrs?.start).toBe(3);
  });

  it("maps tables with headers, spans, widths, alignment and empty cells", () => {
    const r = convert(
      '<table><tr><th>h</th><th colspan="2">wide</th></tr><tbody><tr><td rowspan="2" style="width: 120px; text-align: center;">a</td><td></td><td><div>x</div><div>y</div></td></tr></tbody></table>',
    );
    expect(blocks(r)).toEqual([
      'table(tableRow(tableHeader(paragraph("h")) tableHeader(paragraph("wide"))) tableRow(tableCell(paragraph("a")) tableCell(paragraph) tableCell(paragraph("x") paragraph("y"))))',
    ]);
    const cells = [...all(r.root, "tableHeader"), ...all(r.root, "tableCell")];
    expect(cells[1]?.attrs).toMatchObject({ colspan: 2 });
    expect(cells[2]?.attrs).toMatchObject({ rowspan: 2, colwidth: [120], align: "center" });
  });

  it("maps headings, blockquotes and rules", () => {
    const r = convert("<h2>T <i>i</i></h2><blockquote><div>q</div></blockquote><hr/>");
    expect(blocks(r)).toEqual(['heading("T " "i")', 'blockquote(paragraph("q"))', "horizontalRule"]);
    expect(r.root.content?.[0]?.attrs?.level).toBe(2);
  });

  it("reads both code-block markers and <pre>, keeping indentation and blank lines", () => {
    const r = convert(
      '<div style="-en-codeblock:true;"><div>if (a) {</div><div>    b();<br/></div><div><br/></div><div>}</div></div><div style="--en-codeblock:true;"><div>x</div></div><pre>\n  p\n\nq</pre>',
    );
    expect(all(r.root, "codeBlock").map((c) => c.content?.[0]?.text)).toEqual([
      "if (a) {\n    b();\n\n}",
      "x",
      "  p\n\nq",
    ]);
  });

  it("splits huge code blocks so no single block is slow to edit", () => {
    const lines = Array.from({ length: 2500 }, (_, i) => `<div>line ${i}</div>`).join("");
    const r = convert(`<div style="--en-codeblock:true;">${lines}</div>`);
    const code = all(r.root, "codeBlock");
    expect(code).toHaveLength(3);
    expect(code[0]?.content?.[0]?.text?.split("\n")).toHaveLength(CODE_BLOCK_MAX_LINES);
    expect(code.map((c) => c.content?.[0]?.text).join("\n")).toBe(
      Array.from({ length: 2500 }, (_, i) => `line ${i}`).join("\n"),
    );
    expect(codes(r)).toContain("code_block_split");
  });
});

describe("convertEnml: marks", () => {
  it("maps tags and inline styles to marks, with colors as lowercase #rrggbb", () => {
    const r = convert(
      '<div><b>b</b><span style="font-weight: 700; font-style: italic;">bi</span><u>u</u><s>s</s><span style="text-decoration: underline line-through;">us</span><code>c</code>' +
        '<span style="color: rgb(255, 0, 0); font-family: &quot;Comic Sans&quot;, serif; font-size: 18px;">styled</span><font color="#0F0" size="5" face="Arial">font</font>' +
        '<span style="--en-highlight:yellow;background-color: #FFEF9E;">hl</span><span style="-evernote-highlight:true;">named</span></div>',
    );
    const t = Object.fromEntries(all(r.root, "text").map((n) => [n.text, marksOf(n)]));
    expect(Object.keys(t.b ?? {})).toEqual(["bold"]);
    expect(Object.keys(t.bi ?? {}).sort()).toEqual(["bold", "italic"]);
    expect(Object.keys(t.us ?? {}).sort()).toEqual(["strike", "underline"]);
    expect(Object.keys(t.c ?? {})).toEqual(["code"]);
    expect(t.styled?.textStyle).toEqual({ color: "#ff0000", fontFamily: '"Comic Sans", serif', fontSize: "18px" });
    expect(t.font?.textStyle).toEqual({ color: "#00ff00", fontFamily: "Arial", fontSize: "24px" });
    expect(t.hl?.highlight).toEqual({ color: "#ffef9e" });
    expect(t.named?.highlight).toBeDefined();
  });

  it("keeps a link when code formatting would exclude it, and drops script links", () => {
    const r = convert('<div><a href="https://x.test"><code>both</code></a> <a href="javascript:alert(1)">js</a></div>');
    const t = Object.fromEntries(all(r.root, "text").map((n) => [n.text, marksOf(n)]));
    expect(t.both?.link?.href).toBe("https://x.test");
    expect(t.both?.code).toBeUndefined();
    expect(t.js?.link).toBeUndefined();
  });

  it("rewrites Evernote note links through the resolver and reports the ones it can't", () => {
    const resolver = new NoteLinkResolver([{ noteId: "n-1", title: "Target", guid: null }]);
    const r = convert(
      '<div><a href="evernote:///view/1/s1/aaaaaaaa-0000-4000-8000-000000000000/aaaaaaaa-0000-4000-8000-000000000000/">Target</a> <a href="evernote:///view/1/s1/bbbbbbbb-0000-4000-8000-000000000000/bbbbbbbb-0000-4000-8000-000000000000/">Gone</a> <a href="https://example.com">web</a></div>',
      { resolveLink: (href, text) => resolver.resolve(href, text) },
    );
    const links = all(r.root, "text")
      .map((n) => marksOf(n).link?.href)
      .filter(Boolean);
    expect(links).toEqual([
      "/note/n-1",
      "evernote:///view/1/s1/bbbbbbbb-0000-4000-8000-000000000000/bbbbbbbb-0000-4000-8000-000000000000/",
      "https://example.com",
    ]);
    expect(r.stats).toMatchObject({ linksResolved: 1, linksUnresolved: 1 });
    expect(r.warnings.find((w) => w.code === "evernote_link_unresolved")?.severity).toBe("warning");
  });
});

describe("convertEnml: Evernote elements", () => {
  const resources = [
    { md5: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", resourceId: "img", mime: "image/png", filename: "a.png" },
    { md5: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", resourceId: "pdf", mime: "application/pdf", filename: "b.pdf" },
    { md5: "cccccccccccccccccccccccccccccccc", resourceId: "extra", mime: "audio/m4a", filename: null },
  ];

  it("resolves en-media by MD5 (any case) to inline images and file cards, keeping placement size", () => {
    const r = convert(
      '<div>see <en-media hash="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" type="image/png" width="300" style="height: 200px;"/> here</div><en-media hash="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" type="application/pdf"/><en-media hash="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" type="image/png"/><en-media hash="dddddddddddddddddddddddddddddddd" type="image/png"/>',
      { resources },
    );
    const atts = all(r.root, "attachment").map((a) => a.attrs);
    expect(atts).toEqual([
      { resourceId: "img", display: "inline", mime: "image/png", filename: "a.png", width: 300, height: 200 },
      { resourceId: "pdf", display: "card", mime: "application/pdf", filename: "b.pdf", width: null, height: null },
      { resourceId: "img", display: "inline", mime: "image/png", filename: "a.png", width: null, height: null },
      { resourceId: "extra", display: "card", mime: "audio/m4a", filename: null, width: null, height: null },
    ]);
    // A hash with no resource is kept visibly (raw) and reported, never an empty node.
    expect(all(r.root, "unsupported")[0]?.attrs?.raw).toContain("dddddddd");
    expect(r.stats).toMatchObject({
      mediaRefs: 4,
      mediaMissing: ["dddddddddddddddddddddddddddddddd"],
      unreferencedResources: 1,
    });
    expect(codes(r)).toEqual(expect.arrayContaining(["missing_resource", "unreferenced_resource"]));
  });

  it("keeps en-crypt as a locked node with its attributes and DTD defaults", () => {
    const r = convert(
      '<div>pw: <en-crypt hint="the usual" cipher="AES" length="128">ABC\nDEF=</en-crypt></div><en-crypt>XYZ</en-crypt>',
    );
    expect(all(r.root, "encrypted").map((e) => e.attrs)).toEqual([
      { cipher: "AES", length: 128, hint: "the usual", ciphertext: "ABCDEF=" },
      { cipher: "RC2", length: 64, hint: null, ciphertext: "XYZ" },
    ]);
  });

  it("stores data: images as resources, keeps web images as image nodes, and relative ones verbatim", () => {
    const stored: string[] = [];
    const r = convert(
      '<div><img src="data:image/png;base64,iVBORw0KGgo=" width="10"/><a href="https://x.test"><img src=" https://x.test/a.png " alt="Logo" width="120" style="height: 40px;"/></a><img/><img src="pics/b.png"/></div>',
      {
        storeDataImage: (mime, bytes) => {
          stored.push(`${mime}:${bytes.length}`);
          return { md5: "x", resourceId: "data-1", mime, filename: null };
        },
      },
    );
    expect(stored).toEqual(["image/png:8"]);
    expect(all(r.root, "attachment")[0]?.attrs).toMatchObject({ resourceId: "data-1", width: 10 });
    const [image, ...more] = all(r.root, "image");
    expect(more).toEqual([]);
    expect(image?.attrs).toEqual({ src: "https://x.test/a.png", alt: "Logo", width: 120, height: 40 });
    expect(marksOf(image as J).link?.href).toBe("https://x.test");
    expect(all(r.root, "unsupported").map((u) => u.attrs?.raw)).toEqual(['<img src="pics/b.png">']);
    expect(r.warnings.find((w) => w.code === "remote_image")).toMatchObject({
      severity: "info",
      details: ["https://x.test/a.png"],
    });
    expect(codes(r)).toEqual(
      expect.arrayContaining(["data_image", "remote_image", "image_without_src", "unsupported_element"]),
    );
  });

  it("keeps unknown elements verbatim and drops scripts with a note", () => {
    const r = convert('<div>a <svg viewBox="0 0 1 1"><path d="M0"/></svg> b</div><script>alert(1)</script>');
    expect(all(r.root, "unsupported")[0]?.attrs?.raw).toBe('<svg viewbox="0 0 1 1"><path d="M0"></path></svg>');
    expect(JSON.stringify(r.doc)).not.toContain("alert");
    expect(codes(r)).toEqual(expect.arrayContaining(["unsupported_element", "dropped_element"]));
  });
});

describe("convertEnml: web clips", () => {
  const deepClip = (depth: number, n: number) =>
    Array.from(
      { length: n },
      (_, i) => `${"<div>".repeat(depth)}<span style="color:red">w${i}</span>${"</div>".repeat(depth)}`,
    ).join("");

  it("keeps a page-like note as one sanitized web clip, mapping en-media to resource placeholders", () => {
    const html = `${deepClip(15, 12)}<script>bad()</script><en-media hash="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" type="image/png"/>`;
    const r = convert(html, {
      sanitizeHtml: sanitize,
      resources: [{ md5: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", resourceId: "img", mime: "image/png", filename: "p.png" }],
    });
    expect(blocks(r)).toEqual(["webClip"]);
    const clip = String(r.root.content?.[0]?.attrs?.html);
    expect(clip).toContain('data-resource-id="img"');
    expect(clip).not.toContain("bad()");
    expect(r.root.content?.[0]?.attrs?.sanitizerVersion).toBe(SANITIZER_VERSION);
    expect(r.stats).toMatchObject({ webClip: true, mediaRefs: 1, referencedResources: 1 });
  });

  it("converts normally when the note holds encrypted text, has no sanitizer, or is ordinary text", () => {
    const s = sanitize;
    expect(blocks(convert(`${deepClip(15, 12)}<en-crypt>X</en-crypt>`, { sanitizeHtml: s }))).not.toContain("webClip");
    expect(blocks(convert(deepClip(15, 12)))).not.toContain("webClip");
    const longText = Array.from(
      { length: 400 },
      (_, i) => `<div><span style="background-color:#ff0">t${i}</span></div>`,
    ).join("");
    expect(blocks(convert(longText, { sanitizeHtml: s }))).not.toContain("webClip");
  });

  it("keeps only the clipped part of a modern clip as a web clip", () => {
    const r = convert(`<div>my note</div><div style="--en-clipped-content:fullPage;">${deepClip(15, 5)}</div>`, {
      sanitizeHtml: sanitize,
    });
    expect(blocks(r)).toEqual(['paragraph("my note")', "webClip"]);
  });
});

describe("convertEnml: robustness", () => {
  it("never throws and always returns a valid document, whatever the input", () => {
    const junk = [
      "<div><b><i>unclosed",
      "</div></div>text<<<>>>&&&;",
      "<table><td>no row</td><tr></tr>stray</table>",
      "<ul>text<li><ul></ul></li></ul>",
      "<en-media/><en-crypt/><en-todo/>",
      "\u0000\uD800<div>\uDC00</div>",
      `${"<div>".repeat(3000)}deep${"</div>".repeat(3000)}`,
    ];
    for (const j of junk) {
      const res = convertEnml(`<en-note>${j}</en-note>`);
      expect(checkDoc(res.doc), j.slice(0, 40)).toBeNull();
    }
  });
});

describe("schema v3: alignment, indent, subscript and superscript", () => {
  const paras = (r: { root: J }) =>
    (r.root.content ?? []).map((n) => [n.type, n.attrs?.textAlign ?? null, n.attrs?.indent ?? 0]);

  it("keeps alignment, inherited by nested blocks, and treats left as none", () => {
    const r = convert(
      '<div style="text-align:center"><div>a</div><div style="text-align: right">b</div></div><center>c</center><div style="text-align:left">d</div><div style="text-align:end">e</div>',
    );
    expect(paras(r)).toEqual([
      ["paragraph", "center", 0],
      ["paragraph", "right", 0],
      ["paragraph", "center", 0],
      ["paragraph", null, 0],
      ["paragraph", "right", 0],
    ]);
    expect(codes(r)).not.toContain("formatting_dropped");
    expect(checkDoc(r.doc)).toBeNull();
  });

  it("turns left margins and padding into indent steps that add up, capped", () => {
    const r = convert(
      '<div style="padding-left:40px">a</div><div style="margin-left:40px"><div style="margin-left:80px">b</div></div><div style="margin-left:2000px">c</div><div style="margin-left:3em">d</div>',
    );
    expect(paras(r)).toEqual([
      ["paragraph", null, 1],
      ["paragraph", null, 3],
      ["paragraph", null, 8],
      ["paragraph", null, 1],
    ]);
  });

  it("gives headings their alignment and leaves lists to their own nesting", () => {
    const r = convert('<h2 style="text-align:right">T</h2><div style="margin-left:40px"><ul><li>x</li></ul></div>');
    expect(r.root.content?.[0]).toMatchObject({ type: "heading", attrs: { level: 2, textAlign: "right" } });
    const item = all(r.root, "listItem")[0]?.content?.[0];
    expect(item?.attrs?.indent ?? 0).toBe(0);
  });

  it("maps sub and sup, and the vertical-align styles, to marks", () => {
    const r = convert('<div>H<sub>2</sub>O, x<sup>2</sup>, <span style="vertical-align: super">n</span></div>');
    const texts = all(r.root, "text").map((t) => [t.text, Object.keys(marksOf(t))]);
    expect(texts).toEqual([
      ["H", []],
      ["2", ["subscript"]],
      ["O, x", []],
      ["2", ["superscript"]],
      [", ", []],
      ["n", ["superscript"]],
    ]);
    expect(codes(r)).not.toContain("formatting_dropped");
  });
});
