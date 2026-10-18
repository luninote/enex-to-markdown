import { createReadStream } from "node:fs";
import { join } from "node:path";
import { checkDoc, sanitizeClipHtml } from "@luninote/editor";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { type ConvertResult, convertEnml } from "./convert/convert.ts";
import { NoteLinkResolver } from "./links.ts";
import { type EnexNote, readEnex } from "./reader/index.ts";
import { YARLE as FIXTURES, HAS_YARLE } from "./testing.ts";

// Golden structure tests over the Yarle MIT corpus: key structure per fixture, not full snapshots.

const win = new JSDOM("").window;
const sanitizeHtml = (html: string) => sanitizeClipHtml(html, win as never);

type J = { type: string; text?: string; attrs?: Record<string, unknown>; marks?: J[]; content?: J[] };

interface Converted {
  note: EnexNote;
  result: ConvertResult;
  doc: J;
}

async function load(file: string): Promise<Converted[]> {
  const notes: EnexNote[] = [];
  for await (const n of readEnex(createReadStream(join(FIXTURES, file))).notes) notes.push(n);
  const resolver = new NoteLinkResolver(notes.map((n, i) => ({ noteId: `note-${i}`, title: n.title, guid: n.guid })));
  return notes.map((note) => {
    const result = convertEnml(note.content, {
      resources: note.resources.map((r, i) => ({
        md5: r.digest.md5,
        resourceId: `res-${i}`,
        mime: r.mime ?? "application/octet-stream",
        filename: r.attributes["file-name"] ?? null,
      })),
      tasks: note.tasks,
      resolveLink: (href, text) => resolver.resolve(href, text),
      sanitizeHtml,
    });
    expect(checkDoc(result.doc), file).toBeNull();
    return { note, result, doc: result.doc as J };
  });
}

function all(node: J, type: string): J[] {
  const out: J[] = [];
  const walk = (n: J) => {
    if (n.type === type) out.push(n);
    for (const c of n.content ?? []) walk(c);
  };
  walk(node);
  return out;
}
const text = (n: J): string => (n.type === "text" ? (n.text ?? "") : (n.content ?? []).map(text).join(""));
const top = (d: J) => (d.content ?? []).map((c) => c.type);

describe.skipIf(!HAS_YARLE)("Yarle fixtures", () => {
  it("table.enex: a 2×3 table with column widths and formatted cells", async () => {
    const [{ doc }] = (await load("table.enex")) as [Converted];
    const [table] = all(doc, "table");
    expect(table?.content).toHaveLength(2);
    expect(table?.content?.map((r) => r.content?.length)).toEqual([3, 3]);
    expect(all(doc, "tableCell").map((c) => c.attrs?.colwidth)).toEqual([[130], [130], [300], [130], [130], [300]]);
    expect(all(doc, "tableCell").map(text)).toEqual(["c1r1", "c2r1", "c3r1", "c1r2", "c2r2", "C3r2"]);
  });

  it("checkboxes.enex and checklist.enex: Evernote 10 checklists with their checked states and nesting", async () => {
    const [{ doc }] = (await load("checkboxes.enex")) as [Converted];
    expect(all(doc, "taskItem").map((t) => [text(t), t.attrs?.checked])).toEqual([
      ["Checkbox not completed", false],
      ["Checkbox done", true],
    ]);
    const [{ doc: list }] = (await load("checklist.enex")) as [Converted];
    const items = all(list, "taskItem");
    expect(items.map((t) => t.attrs?.checked)).toEqual([false, false, true, true, false, false, false]);
    expect(all(items[0] as J, "taskList")).toHaveLength(1);
    expect(all(list, "codeBlock").map(text)).toEqual(["codeblock"]);
  });

  it("empty-en-todo.enex: legacy en-todo list items become one task list", async () => {
    const [{ doc }] = (await load("empty-en-todo.enex")) as [Converted];
    expect(top(doc)).toEqual(["paragraph", "taskList", "paragraph"]);
    expect(all(doc, "taskItem").map((t) => t.attrs?.checked)).toEqual([true, true, false]);
  });

  it("things-to-do.enex: Evernote Tasks in their group, ordered by sort weight", async () => {
    const [{ doc, result }] = (await load("things-to-do.enex")) as [Converted];
    expect(all(doc, "taskItem").map((t) => [text(t), t.attrs?.checked])).toEqual([
      ["Simple task", false],
      ["Task with a reminder", false],
      ["Done", true],
      ["Task with due date", false],
      ["Task with a flag", false],
    ]);
    expect(result.stats.tasks).toBe(5);
  });

  it("links.enex: an evernote:/// link to another note in the file is rewritten", async () => {
    const [noteB] = (await load("links.enex")) as [Converted];
    const link = all(noteB.doc, "text").find((t) => t.text === "NoteA");
    expect(link?.marks?.find((m) => m.type === "link")?.attrs?.href).toBe("/note/note-1");
    expect(noteB.result.stats.linksResolved).toBe(1);
  });

  it("encryption.enex: en-crypt kept with cipher, length, hint and ciphertext", async () => {
    const [{ doc }] = (await load("encryption.enex")) as [Converted];
    const [enc] = all(doc, "encrypted");
    expect(enc?.attrs).toMatchObject({ cipher: "AES", length: 128, hint: "this is a hint" });
    expect(String(enc?.attrs?.ciphertext)).toMatch(/^RU5DMCR2SQ/);
    expect(all(doc, "paragraph").map(text).filter(Boolean)).toEqual([
      "This is NOT an encrypted test",
      "This is NOT an encrypted test again",
    ]);
  });

  it("threePictures.enex and noteWithPdf.enex: images inline, PDFs as cards, all hashes matched", async () => {
    const [{ doc, result }] = (await load("threePictures.enex")) as [Converted];
    const atts = all(doc, "attachment");
    expect(atts).toHaveLength(3);
    expect(atts.every((a) => a.attrs?.display === "inline" && String(a.attrs?.mime).startsWith("image/"))).toBe(true);
    expect(result.stats.mediaMissing).toEqual([]);
    const [{ doc: pdf }] = (await load("noteWithPdf.enex")) as [Converted];
    expect(all(pdf, "attachment").map((a) => [a.attrs?.display, a.attrs?.mime])).toEqual([["card", "application/pdf"]]);
  });

  it("noteWithCodeBlock.enex: two code blocks with their indentation", async () => {
    const [{ doc }] = (await load("noteWithCodeBlock.enex")) as [Converted];
    const code = all(doc, "codeBlock").map(text);
    expect(code).toHaveLength(2);
    expect(code[0]).toBe("# This program prints *Hello, world* in _Python_\nprint('Hello, world!\\n')");
    expect(code[1]?.split("\n")).toHaveLength(14);
    expect(code[1]).toContain('            println!("fizzbuzz");');
  });

  it("huge-html.enex: the 1.4 MB legacy page becomes one sanitized web clip", async () => {
    const [{ doc, result, note }] = (await load("huge-html.enex")) as [Converted];
    expect(top(doc)).toEqual(["webClip"]);
    const html = String(doc.content?.[0]?.attrs?.html);
    expect(html.length).toBeGreaterThan(100_000);
    expect(html).not.toMatch(/<script|javascript:/i);
    expect(result.stats.webClip).toBe(true);
    // Every en-media in the clip points at one of the note's resources.
    expect(result.stats.mediaMissing).toEqual([]);
    expect(result.stats.referencedResources).toBe(new Set(note.resources.map((r) => r.digest.md5)).size);
  });

  it("sublists-valid.enex and sublists-invalid.enex: nested lists keep their depth", async () => {
    for (const f of ["sublists-valid.enex", "sublists-invalid.enex"]) {
      const [{ doc }] = (await load(f)) as [Converted];
      const depth = (n: J, d = 0): number =>
        Math.max(d, ...(n.content ?? []).map((c) => depth(c, c.type.endsWith("List") ? d + 1 : d)));
      expect(depth(doc), f).toBeGreaterThanOrEqual(3);
    }
  });

  it("Colors.enex and highlights2.enex: text colors and highlights as lowercase hex", async () => {
    const [{ doc }] = (await load("Colors.enex")) as [Converted];
    const marks = all(doc, "text").flatMap((t) => t.marks ?? []);
    const colors = marks.filter((m) => m.type === "textStyle").map((m) => m.attrs?.color);
    const highlights = marks.filter((m) => m.type === "highlight").map((m) => m.attrs?.color);
    expect(colors).toContain("#fc1233");
    expect(highlights).toContain("#fec1d0");
    for (const c of [...colors, ...highlights].filter(Boolean)) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    const [{ doc: h2 }] = (await load("highlights2.enex")) as [Converted];
    const quote = all(h2, "text").find((t) => t.text?.startsWith("My ego"));
    expect(quote?.marks?.map((m) => m.type).sort()).toEqual(["bold", "highlight"]);
  });

  it("newlines.enex: every way of writing a line break gives the lines a browser shows", async () => {
    const [{ doc }] = (await load("newlines.enex")) as [Converted];
    const lines = all(doc, "paragraph").flatMap((p) =>
      (p.content ?? []).reduce<string[]>(
        (acc, n) => {
          if (n.type === "hardBreak") acc.push("");
          else acc[acc.length - 1] += n.text ?? "";
          return acc;
        },
        [""],
      ),
    );
    expect(lines.filter(Boolean)).toEqual(Array.from({ length: 16 }, (_, i) => `Line ${i + 1}`));
  });

  it("withPicture.enex: recognition text harvested from recoIndex in reading order", async () => {
    const [{ note }] = (await load("withPicture.enex")) as [Converted];
    expect(note.resources[0]?.recognition).toMatchObject({ items: 4, lang: "hu" });
    expect(note.resources[0]?.recognition?.text.split(/\s+/)).toEqual(["'U", "sea", "I\\,.", "did"]);
  });
});
