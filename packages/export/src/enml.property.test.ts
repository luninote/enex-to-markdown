import { compactDoc, getEditorSchema, type JSONContent } from "@luninote/editor";
import { everyFeatureDoc } from "@luninote/editor/fixtures";
import { convertEnml } from "@luninote/enml";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { DocNode } from "./doc.ts";
import { docToEnml } from "./enml.ts";

// Documents in the shape the importer produces, generated at random: writing them as ENML and converting back must
// give the same document. Characters a note can't round-trip (a newline inside a text node, which ENML can only
// write as a line break) are left out of the generator.

const canonical = (doc: JSONContent): JSONContent =>
  compactDoc(getEditorSchema().nodeFromJSON(doc).toJSON() as JSONContent) as JSONContent;

const RESOURCES = [
  { id: "0199d3a0-0000-7000-8000-000000000001", md5: `${"0".repeat(31)}1`, mime: "image/png", filename: "a.png" },
  { id: "0199d3a0-0000-7000-8000-000000000002", md5: `${"0".repeat(31)}2`, mime: "application/pdf", filename: "b.pdf" },
];

const ctx = {
  resource: (id: string) => {
    const r = RESOURCES.find((x) => x.id === id);
    return r ? { md5: r.md5, mime: r.mime } : null;
  },
};

// Control characters XML can't hold (form feed and the like) are dropped from every export: not generated here.
const textChars = fc.constantFrom(...Array.from("ab Z 0 \t  &<>\"'é€中😀"), "  ", " ");
const text = fc.array(textChars, { minLength: 1, maxLength: 8 }).map((a) => a.join(""));
const hex = fc
  .tuple(fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 }))
  .map(([r, g, b]) => `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`);

type Mark = { type: string; attrs?: Record<string, unknown> };

const mark: fc.Arbitrary<Mark> = fc.oneof(
  fc.constant({ type: "bold" }),
  fc.constant({ type: "italic" }),
  fc.constant({ type: "underline" }),
  fc.constant({ type: "strike" }),
  fc.constantFrom("https://example.org/a", "mailto:x@example.org", "evernote:///view/1/s1/abc/abc/").map((href) => ({
    type: "link",
    attrs: { href, target: null, rel: null, class: null, title: null },
  })),
  fc
    .record({
      color: fc.option(hex, { nil: null }),
      fontFamily: fc.option(fc.constantFrom("Georgia, serif", '"Courier New", monospace'), { nil: null }),
      fontSize: fc.option(fc.constantFrom("13px", "18px", "1.5em"), { nil: null }),
    })
    .filter((a) => a.color !== null || a.fontFamily !== null || a.fontSize !== null)
    .map((attrs) => ({ type: "textStyle", attrs })),
  fc.option(hex, { nil: null }).map((color) => ({ type: "highlight", attrs: { color } })),
  fc.constantFrom({ type: "subscript" }, { type: "superscript" }),
);
// Subscript and superscript exclude each other: one of them at most per text.
const markKind = (m: Mark) => (m.type === "subscript" || m.type === "superscript" ? "script" : m.type);

const marks: fc.Arbitrary<Mark[]> = fc.oneof(
  { weight: 5, arbitrary: fc.uniqueArray(mark, { maxLength: 3, selector: markKind }) },
  { weight: 1, arbitrary: fc.constant<Mark[]>([{ type: "code" }]) },
);

const inline: fc.Arbitrary<JSONContent> = fc.oneof(
  { weight: 8, arbitrary: fc.record({ type: fc.constant("text"), text, marks }) },
  { weight: 2, arbitrary: fc.constant({ type: "hardBreak" }) },
  {
    weight: 1,
    arbitrary: fc
      .record({
        r: fc.constantFrom(...RESOURCES),
        width: fc.option(fc.integer({ min: 1, max: 2000 }), { nil: null }),
        height: fc.option(fc.integer({ min: 1, max: 2000 }), { nil: null }),
        marks,
      })
      .map(({ r, width, height, marks }) => ({
        type: "attachment",
        attrs: {
          resourceId: r.id,
          display: r.mime.startsWith("image/") ? "inline" : "card",
          mime: r.mime,
          filename: r.filename,
          width,
          height,
        },
        marks,
      })),
  },
  {
    weight: 1,
    arbitrary: fc
      .record({
        cipher: fc.constantFrom("AES", "RC2"),
        length: fc.integer({ min: 1, max: 4096 }),
        hint: fc.option(fc.constantFrom("the usual", "", 'a "q" & <b>'), { nil: null }),
        ciphertext: fc.constantFrom("RU5DMA==", "abc+/="),
      })
      .map((attrs) => ({ type: "encrypted", attrs })),
  },
  {
    weight: 1,
    arbitrary: fc
      .record({
        src: fc.constantFrom("https://example.org/x.png", "http://example.org/a b.jpg?x=1&y=2"),
        alt: fc.option(fc.constantFrom("Harbor", "a & b"), { nil: null }),
        width: fc.option(fc.integer({ min: 1, max: 999 }), { nil: null }),
        height: fc.option(fc.integer({ min: 1, max: 999 }), { nil: null }),
      })
      .map((attrs) => ({ type: "image", attrs })),
  },
);

const inlines = fc.array(inline, { maxLength: 6 });
// Schema v3 block formatting, absent most of the time as in real notes.
const blockAttrs = fc.oneof(
  { weight: 3, arbitrary: fc.constant({}) },
  {
    weight: 1,
    arbitrary: fc
      .record({
        textAlign: fc.constantFrom(null, "center", "right", "justify"),
        indent: fc.integer({ min: 0, max: 8 }),
      })
      .map((a) => Object.fromEntries(Object.entries(a).filter(([, v]) => v !== null && v !== 0))),
  },
);
const para = fc.record({ content: inlines, attrs: blockAttrs }).map(({ content, attrs }) => ({
  type: "paragraph",
  ...(Object.keys(attrs).length ? { attrs } : {}),
  ...(content.length ? { content } : {}),
}));

const codeText = fc
  .array(fc.constantFrom("x = 1;", "  indented", "", "\tif (a < b) {", "}", "& <tag>"), { maxLength: 5 })
  .map((lines) => lines.join("\n").replace(/\n+$/, ""));

const { block } = fc.letrec<{ block: JSONContent; blocks: JSONContent[] }>((tie) => ({
  blocks: fc.array(tie("block"), { minLength: 1, maxLength: 3 }),
  block: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    { weight: 6, arbitrary: para },
    {
      weight: 1,
      arbitrary: fc.record({
        type: fc.constant("heading"),
        attrs: fc
          .record({ level: fc.integer({ min: 1, max: 6 }), more: blockAttrs })
          .map(({ level, more }) => ({ level, ...more })),
        content: inlines,
      }),
    },
    { weight: 1, arbitrary: fc.constant({ type: "horizontalRule" }) },
    {
      weight: 1,
      arbitrary: codeText.map((t) => ({
        type: "codeBlock",
        attrs: { language: null },
        ...(t ? { content: [{ type: "text", text: t }] } : {}),
      })),
    },
    { weight: 1, arbitrary: tie("blocks").map((content) => ({ type: "blockquote", content })) },
    {
      weight: 1,
      arbitrary: fc
        .array(
          fc.tuple(para, fc.array(tie("block"), { maxLength: 2 })).map(([p, rest]) => ({
            type: "listItem",
            content: [p, ...rest],
          })),
          { minLength: 1, maxLength: 3 },
        )
        .map((content) => ({ type: "bulletList", content })),
    },
    {
      weight: 1,
      arbitrary: fc
        .record({
          start: fc.integer({ min: 1, max: 30 }),
          type: fc.constantFrom(null, "a", "I"),
          items: fc.array(
            para.map((p) => ({ type: "listItem", content: [p] })),
            { minLength: 1, maxLength: 3 },
          ),
        })
        .map(({ start, type, items }) => ({ type: "orderedList", attrs: { start, type }, content: items })),
    },
    {
      weight: 1,
      arbitrary: fc
        .array(
          fc.tuple(fc.boolean(), para, fc.array(tie("block"), { maxLength: 1 })).map(([checked, p, rest]) => ({
            type: "taskItem",
            attrs: { checked },
            content: [p, ...rest],
          })),
          { minLength: 1, maxLength: 3 },
        )
        .map((content) => ({ type: "taskList", content })),
    },
    {
      // Evernote Tasks: one line of plain text each; ids are filled in per document below.
      weight: 1,
      arbitrary: fc
        .array(
          fc
            .record({
              checked: fc.boolean(),
              flagged: fc.boolean(),
              due: fc.constantFrom(null, "2026-11-02T09:00:00.000Z", "2027-01-31T23:59:59.250Z"),
              title: fc.constantFrom("", "Renew passport", "Call <Ann> & Bo", "中文 task"),
            })
            .map(({ checked, flagged, due, title }) => ({
              type: "taskItem",
              attrs: { checked, flagged, due, taskId: "?" },
              content: [
                title ? { type: "paragraph", content: [{ type: "text", text: title }] } : { type: "paragraph" },
              ],
            })),
          { minLength: 1, maxLength: 3 },
        )
        .map((content) => ({ type: "taskList", content })),
    },
    {
      weight: 1,
      arbitrary: fc
        .array(
          fc.array(
            fc
              .record({
                header: fc.boolean(),
                colspan: fc.integer({ min: 1, max: 2 }),
                rowspan: fc.integer({ min: 1, max: 2 }),
                width: fc.option(fc.integer({ min: 20, max: 400 }), { nil: null }),
                align: fc.constantFrom(null, "left", "center", "right"),
                content: fc.array(para, { minLength: 1, maxLength: 2 }),
              })
              .map((c) => ({
                type: c.header ? "tableHeader" : "tableCell",
                attrs: {
                  colspan: c.colspan,
                  rowspan: c.rowspan,
                  colwidth: c.width && c.colspan === 1 ? [c.width] : null,
                  align: c.align,
                },
                content: c.content,
              })),
            { minLength: 1, maxLength: 3 },
          ),
          { minLength: 1, maxLength: 3 },
        )
        .map((rows) => ({ type: "table", content: rows.map((content) => ({ type: "tableRow", content })) })),
    },
  ),
}));

function numberTasks(doc: JSONContent): JSONContent {
  let n = 0;
  const walk = (node: JSONContent) => {
    if (node.attrs?.taskId === "?") node.attrs.taskId = `task-${++n}`;
    for (const c of node.content ?? []) walk(c);
  };
  walk(doc);
  return doc;
}

const docArb = fc
  .array(block, { minLength: 1, maxLength: 5 })
  .map((content) => canonical(numberTasks(structuredClone({ type: "doc", content }))));

describe("docToEnml ∘ convertEnml on generated documents", () => {
  it("gives back the same document", () => {
    fc.assert(
      fc.property(docArb, (doc) => {
        const { enml, resourceIds, tasks } = docToEnml(doc as DocNode, ctx);
        const again = convertEnml(enml, {
          resources: RESOURCES.filter((r) => resourceIds.includes(r.id)).map((r) => ({
            md5: r.md5,
            resourceId: r.id,
            mime: r.mime,
            filename: r.filename,
          })),
          tasks: tasks.map((t) => ({ ...t, dueDate: t.dueDate ? new Date(t.dueDate) : null })),
        }).doc;
        expect(again, enml).toEqual(doc);
      }),
      { numRuns: Number(process.env.RUNS ?? 1500) },
    );
  }, 600_000);

  it("everyFeatureDoc: everything but the documented differences comes back", () => {
    const doc = canonical(everyFeatureDoc) as DocNode;
    const { enml, tasks } = docToEnml(doc, ctx);
    const again = convertEnml(enml, {
      resources: RESOURCES.map((r, i) => ({
        md5: r.md5,
        resourceId: r.id,
        mime: r.mime,
        filename: ["map.png", "itinerary.pdf"][i] as string,
      })),
      tasks: tasks.map((t) => ({ ...t, dueDate: t.dueDate ? new Date(t.dueDate) : null })),
    }).doc as DocNode;
    const expected = structuredClone(doc);
    for (const b of expected.content ?? []) {
      // ENML has no notation for a code block's language.
      if (b.type === "codeBlock" && b.attrs) b.attrs.language = null;
    }
    const isClip = (b: DocNode) => b.type === "webClip";
    // A small clip next to other content is converted to editable text by the importer (it isn't a page layout).
    expect(again.content?.filter((b) => !isClip(b) && !["heading", "paragraph"].includes(b.type))).toEqual(
      expected.content?.filter((b) => !isClip(b) && !["heading", "paragraph"].includes(b.type)),
    );
    const texts = (d: DocNode) => (d.content ?? []).filter((b) => b.type === "paragraph").length;
    expect(texts(again)).toBe(texts(expected) + 1);
  });
});
