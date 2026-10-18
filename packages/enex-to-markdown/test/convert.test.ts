import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { docToMarkdown } from "@luninote/export";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ConvertOptions, convertEnex, UsageError, WARNINGS_FILE } from "../src/convert.ts";
import { enex, md5, type NoteSpec, noteXml, read, tempDir } from "./enex.ts";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const PDF = Buffer.from("%PDF-1.4 tiny");
const GUID = (n: number) => `0a1b2c3d-0000-4000-8000-${String(n).padStart(12, "0")}`;
const link = (text: string, guid = GUID(999)) => `<a href="evernote:///view/111/s1/${guid}/${guid}/">${text}</a>`;

let dir: string;
let done: () => Promise<void>;
beforeEach(async () => {
  ({ path: dir, done } = await tempDir());
});
afterEach(async () => {
  await done();
});

async function writeEnex(name: string, notes: (NoteSpec | string)[] | string): Promise<string> {
  const path = join(dir, "in", name);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, typeof notes === "string" ? notes : enex(notes));
  return path;
}

async function run(inputs: string[], opts: Partial<ConvertOptions> = {}) {
  const out = join(dir, "out");
  const summary = await convertEnex(inputs, { outDir: out, ...opts });
  return { out, summary, md: (p: string) => read(join(out, p)) };
}

describe("links between notes", () => {
  it("rewrites links to notes in the same run to relative links, across notebooks too", async () => {
    const a = await writeEnex("Work.enex", [
      { title: "Plan", body: `<div>See ${link("Budget")} and ${link("Recipe")}.</div>` },
      { title: "Budget" },
    ]);
    const b = await writeEnex("Home.enex", [{ title: "Recipe", body: `<div>Back to ${link("Plan")}</div>` }]);
    const { md, summary } = await run([a, b]);
    expect(await md("Work/Plan.md")).toContain("See [Budget](<Budget.md>) and [Recipe](<../Home/Recipe.md>).");
    expect(await md("Home/Recipe.md")).toContain("Back to [Plan](<../Work/Plan.md>)");
    expect(summary.linksRewritten).toBe(3);
  });

  it("resolves by note GUID when the export carries one, whatever the link text", async () => {
    const a = await writeEnex("Work.enex", [
      { title: "Source", body: `<div>${link("click here", GUID(7))}</div>` },
      { title: "Target note", extra: `<guid>${GUID(7)}</guid>` },
    ]);
    const { md } = await run([a]);
    expect(await md("Work/Source.md")).toContain("[click here](<Target%20note.md>)");
  });

  it("points a link at the right file when the target's title was taken and its file renamed", async () => {
    const a = await writeEnex("Work.enex", [
      { title: "Notes", extra: `<guid>${GUID(1)}</guid>` },
      { title: "notes", extra: `<guid>${GUID(2)}</guid>` },
      { title: "Index", body: `<div>${link("second", GUID(2))}</div>` },
    ]);
    const { md } = await run([a]);
    expect(await md("Work/Index.md")).toContain("[second](<notes%20%282%29.md>)");
  });

  it("keeps links it can't match as Evernote links and lists them", async () => {
    const a = await writeEnex("Work.enex", [
      { title: "Source", body: `<div>${link("Gone")} ${link("Twin")}</div>` },
      { title: "Twin" },
      { title: "Twin" },
    ]);
    const { out, md } = await run([a]);
    const text = await md("Work/Source.md");
    expect(text).toContain(`[Gone](<evernote:///view/111/s1/${GUID(999)}/${GUID(999)}/>)`);
    expect(text).toContain("[Twin](<evernote:///");
    const report = await read(join(out, WARNINGS_FILE));
    expect(report).toContain("Work/Source.md");
    expect(report).toContain("no note in this run has its text as a title.");
    expect(report).toContain('"Gone"');
    expect(report).toContain(
      'several notes in this run have its text as a title.\n      "Twin": Work/Twin.md, Work/Twin (2).md',
    );
  });
});

describe("names", () => {
  it("gives duplicate and unsafe titles unique, portable file names", async () => {
    const a = await writeEnex("Work.enex", [
      { title: "Plan" },
      { title: "Plan" },
      { title: "PLAN" },
      { title: 'a/b: "c"*?' },
      { title: "CON" },
      { title: "" },
      { title: "trailing dots..." },
    ]);
    const { out } = await run([a]);
    const files = (await readdir(join(out, "Work"))).sort();
    expect(files).toEqual(
      ["Plan.md", "Plan (2).md", "PLAN (3).md", "a_b_ _c___.md", "_CON.md", "Untitled.md", "trailing dots.md"].sort(),
    );
    expect(await read(join(out, "Work", "a_b_ _c___.md"))).toContain('title: "a/b: \\"c\\"*?"');
  });

  it("mirrors input folders and keeps notebooks with the same name apart", async () => {
    await writeEnex("Stack A/Ideas.enex", [{ title: "One" }]);
    await writeEnex("Stack B/Ideas.enex", [{ title: "Two" }]);
    await writeEnex("ideas/Inner.enex", [{ title: "Three" }]);
    await writeEnex("Ideas.ENEX", [{ title: "Four" }]);
    const { out, summary } = await run([join(dir, "in")]);
    expect(summary.notebooks).toBe(4);
    expect(existsSync(join(out, "Stack A", "Ideas", "One.md"))).toBe(true);
    expect(existsSync(join(out, "Stack B", "Ideas", "Two.md"))).toBe(true);
    // A folder of the input and a notebook file with the same name (any case) don't merge.
    expect(existsSync(join(out, "ideas", "Inner", "Three.md"))).toBe(true);
    expect(existsSync(join(out, "Ideas (2)", "Four.md"))).toBe(true);
  });

  it("refuses to write into a folder that already has files, unless told to", async () => {
    const a = await writeEnex("Work.enex", [{ title: "One" }]);
    await mkdir(join(dir, "out"), { recursive: true });
    await writeFile(join(dir, "out", "keep.txt"), "mine");
    await expect(run([a])).rejects.toBeInstanceOf(UsageError);
    await run([a], { overwrite: true });
    expect(await read(join(dir, "out", "keep.txt"))).toBe("mine");
    expect(existsSync(join(dir, "out", "Work", "One.md"))).toBe(true);
  });
});

describe("attachments", () => {
  it("writes each attachment once, next to its note, with relative links that match the bytes", async () => {
    const a = await writeEnex("Work.enex", [
      {
        title: "Scans",
        body: `<div><en-media hash="${md5(PNG)}" type="image/png"/></div><div><en-media hash="${md5(PDF)}" type="application/pdf"/></div>`,
        resources: [
          { data: PNG, mime: "image/png", fileName: "scan.png" },
          { data: PDF, mime: "application/pdf", fileName: "scan.png" },
          { data: Buffer.from("orphan"), mime: "text/plain" },
          { data: PNG, mime: "image/png" },
        ],
      },
      { title: "Scans", resources: [{ data: PNG, mime: "image/png", fileName: "scan.png" }] },
    ]);
    const { out, md, summary } = await run([a]);
    const text = await md("Work/Scans.md");
    expect(text).toContain("![scan.png](<_resources/Scans/scan.png>)");
    // The second resource claims the same name but is a PDF: it gets its own unique file.
    expect(text).toContain("[scan.png](<_resources/Scans/scan%20%282%29.png>)");
    // Attachments the note body never shows are still linked, at the end.
    expect(text).toContain("[attachment-3.txt](<_resources/Scans/attachment-3.txt>)");
    expect(await readFile(join(out, "Work/_resources/Scans/scan.png"))).toEqual(PNG);
    expect(await readFile(join(out, "Work/_resources/Scans/scan (2).png"))).toEqual(PDF);
    expect(await readFile(join(out, "Work/_resources/Scans/attachment-3.txt"), "utf8")).toBe("orphan");
    // A duplicate of an attachment already shown is the same file, not a lost one.
    expect(existsSync(join(out, "Work/_resources/Scans/image-4.png"))).toBe(true);
    expect(await md("Work/Scans (2).md")).toContain("](<_resources/Scans%20%282%29/scan.png>)");
    expect(summary.attachments).toBe(5);
    expect(existsSync(join(out, ".enex-to-markdown-tmp"))).toBe(false);
  });

  it("writes a visible placeholder for an attachment the export lacks, and lists it", async () => {
    const a = await writeEnex("Work.enex", [
      {
        title: "Broken",
        body: `<div>before <en-media hash="${"0".repeat(32)}" type="image/png"/> after</div><div><en-media hash="${md5(Buffer.alloc(0))}" type="application/pdf"/></div>`,
        resources: [{ data: null, mime: "application/pdf", fileName: "lost.pdf" }],
      },
    ]);
    const { out, md } = await run([a]);
    const text = await md("Work/Broken.md");
    expect(text).toContain("before \\[Missing attachment\\] after");
    expect(text).toContain("\\[lost.pdf\\] (missing)");
    const report = await read(join(out, WARNINGS_FILE));
    expect(report).toContain("isn't in the export");
    expect(report).toContain("no data in the export");
  });

  it("stores inline data: images as files", async () => {
    const a = await writeEnex("Work.enex", [
      { title: "Inline", body: `<div><img src="data:image/png;base64,${PNG.toString("base64")}"/></div>` },
    ]);
    const { out, md } = await run([a]);
    expect(await md("Work/Inline.md")).toContain("![image-1.png](<_resources/Inline/image-1.png>)");
    expect(await readFile(join(out, "Work/_resources/Inline/image-1.png"))).toEqual(PNG);
  });
});

describe("content", () => {
  it("leaves text colors out unless asked, without losing the text or the links around it", async () => {
    const a = await writeEnex("Work.enex", [
      { title: "Target", extra: `<guid>${GUID(1)}</guid>` },
      {
        title: "Colors",
        body: `<div><span style="color:#ffffff">white</span> and ${link('<span style="color:rgb(105,170,53)">Target</span>', GUID(1))}</div>`,
      },
    ]);
    const plain = await (await run([a])).md("Work/Colors.md");
    expect(plain).not.toContain("<span");
    expect(plain).toContain("white and [Target](<Target.md>)");
    await convertEnex([a], { outDir: join(dir, "kept"), keepColors: true });
    expect(await read(join(dir, "kept", "Work", "Colors.md"))).toContain('<span style="color:');
  });

  it("writes simple tables as GFM and merged cells as an HTML table", async () => {
    const a = await writeEnex("Work.enex", [
      {
        title: "Tables",
        body:
          "<table><tr><th>A</th><th style='text-align:right'>B</th></tr><tr><td>1 | 2</td><td><b>bold</b></td></tr></table>" +
          "<table><tr><td colspan='2'>wide</td></tr><tr><td>x</td><td>y</td></tr></table>",
      },
    ]);
    const { md } = await run([a]);
    const text = await md("Work/Tables.md");
    expect(text).toContain("| A | B |\n| --- | ---: |\n| 1 \\| 2 | **bold** |");
    expect(text).toMatch(/<table>.*colspan="2".*wide.*<\/table>/);
  });

  it("writes checkboxes and Evernote Tasks as task list items", async () => {
    const task = (title: string, status: string, weight: string, due = "") =>
      `<task><title>${title}</title><taskStatus>${status}</taskStatus><taskFlag>false</taskFlag><sortWeight>${weight}</sortWeight><noteLevelID>${title}</noteLevelID><taskGroupNoteLevelID>g1</taskGroupNoteLevelID>${due}</task>`;
    const a = await writeEnex("Work.enex", [
      {
        title: "Todo",
        body: `<div><en-todo checked="true"/>Done thing</div><div><en-todo/>Open thing</div><div style="--en-task-group:true; --en-id:g1;"></div>`,
        extra:
          task("Call the bank", "open", "B", "<dueDate>20240110T090000Z</dueDate>") +
          task("Pay rent", "completed", "A"),
      },
    ]);
    const { md } = await run([a]);
    const text = await md("Work/Todo.md");
    expect(text).toContain("- [x] Done thing\n- [ ] Open thing");
    expect(text).toContain("- [x] Pay rent\n- [ ] Call the bank *(due 2024-01-10 09:00)*");
  });

  it("keeps encrypted text as a locked placeholder with its ciphertext, and lists it with the hint", async () => {
    const a = await writeEnex("Work.enex", [
      { title: "Secret", body: '<div>PIN: <en-crypt hint="dog" cipher="AES" length="128">Q0lQSEVS</en-crypt></div>' },
    ]);
    const { out, md } = await run([a]);
    const text = await md("Work/Secret.md");
    expect(text).toContain("[Encrypted text]");
    expect(text).toContain('data-ciphertext="Q0lQSEVS"');
    const report = await read(join(out, WARNINGS_FILE));
    expect(report).toContain("Encrypted text was kept");
    expect(report).toContain("hint: dog");
  });

  it("writes front matter with title, dates, tags, source URL and author", async () => {
    const a = await writeEnex("Work.enex", [
      {
        title: "Clip: it's #1",
        tags: ["web", 'odd "tag"'],
        attributes: { author: "Someone", "source-url": "https://example.com/a?b=c&d" },
      },
    ]);
    const { md } = await run([a]);
    const text = await md("Work/Clip_ it's #1.md");
    expect(
      text.startsWith(`---
title: "Clip: it's #1"
created: 2024-01-02T03:04:05Z
updated: 2024-01-03T03:04:05Z
tags:
  - "web"
  - "odd \\"tag\\""
source: "https://example.com/a?b=c&d"
author: "Someone"
---

# Clip: it's #1
`),
    ).toBe(true);
  });

  it("converts web clips to Markdown, or keeps heavy ones as HTML pointing at their files when asked", async () => {
    const boxes = Array.from(
      { length: 160 },
      (_, i) => `<div style="float:left;color:#333"><span>Paragraph ${i}</span></div>`,
    ).join("");
    const clip: NoteSpec = {
      title: "Article",
      body: `<div><h1>Headline</h1>${boxes}<en-media hash="${md5(PNG)}" type="image/png"/><script>alert(1)</script></div>`,
      resources: [{ data: PNG, mime: "image/png", fileName: "hero.png" }],
      attributes: { "source-url": "https://example.com/article" },
    };
    const a = await writeEnex("Clips.enex", [clip]);
    const plain = await run([a]);
    const md = await plain.md("Clips/Article.md");
    expect(md).toContain("# Headline");
    expect(md).toContain("Paragraph 159");
    expect(md).toContain("![hero.png](<_resources/Article/hero.png>)");
    expect(md).not.toContain("alert(1)");

    const kept = await run([a], { keepClipHtml: true, overwrite: true });
    const html = await kept.md("Clips/Article.md");
    expect(html).toContain('<div class="web-clip">');
    expect(html).toContain('src="_resources/Article/hero.png"');
    expect(html).toContain("Paragraph 159");
    expect(html).not.toContain("<script");
  });

  it("writes a placeholder for notes from a password-protected export", async () => {
    const a = await writeEnex(
      "Work.enex",
      enex([
        `<note><title>Locked</title><content encoding="base64:aes">AAAA</content><created>20240102T030405Z</created></note>`,
        { title: "Open" },
      ]),
    );
    const { out, md, summary } = await run([a]);
    expect(await md("Work/Locked.md")).toContain("exported with a password");
    expect(await md("Work/Open.md")).toContain("text");
    expect(summary.notesFailed).toBe(1);
    expect(await read(join(out, WARNINGS_FILE))).toContain("Export it again without a password");
  });
});

describe("damaged input", () => {
  it("keeps going past a malformed note", async () => {
    const broken = `<note><title>Broken</title><content>not cdata <b>unclosed & stray</content><created>nonsense</created></note>`;
    const a = await writeEnex("Work.enex", enex([{ title: "Before" }, broken, { title: "After" }]));
    const { out, md, summary } = await run([a]);
    expect(summary.notes).toBe(3);
    expect(await md("Work/Before.md")).toContain("text");
    expect(await md("Work/After.md")).toContain("text");
    expect(existsSync(join(out, "Work", "Broken.md"))).toBe(true);
    const report = await read(join(out, WARNINGS_FILE));
    expect(report).toContain("Work/Broken.md");
    expect(report).toContain("couldn't be read");
  });

  it("keeps the original markup of a note that fails to convert, and converts the rest", async () => {
    const a = await writeEnex("Work.enex", [{ title: "Fine" }, { title: "Explodes", body: "<div>boom</div>" }]);
    const { out, md, summary } = await run([a], {
      render: (doc, ctx, note) => {
        if (note.title === "Explodes") throw new Error("renderer failed");
        return docToMarkdown(doc, ctx);
      },
    });
    expect(await md("Work/Fine.md")).toContain("text");
    const failed = await md("Work/Explodes.md");
    expect(failed).toContain("couldn't be converted");
    expect(failed).toContain("```html\n");
    expect(failed).toContain("<div>boom</div>");
    expect(summary.notesFailed).toBe(1);
    expect(await read(join(out, WARNINGS_FILE))).toContain("renderer failed");
  });

  it("reports a file that isn't an export and a cut-off export, and converts the others", async () => {
    const bad = await writeEnex("Notes.enex", "this is not xml at all, just text");
    const cut = await writeEnex(
      "Cut.enex",
      enex([{ title: "Whole" }]).replace(/<\/en-export>\s*$/, noteXml({ title: "Half" }).slice(0, 120)),
    );
    const good = await writeEnex("Good.enex", [{ title: "Fine" }]);
    const { out, summary } = await run([bad, cut, good]);
    expect(summary.filesFailed).toBe(1);
    expect(summary.notebooks).toBe(2);
    expect(existsSync(join(out, "Good", "Fine.md"))).toBe(true);
    expect(existsSync(join(out, "Cut", "Whole.md"))).toBe(true);
    const report = await read(join(out, WARNINGS_FILE));
    expect(report).toContain("isn't an Evernote export");
    expect(report).toContain("ends in the middle of a note");
    expect(report).toContain("Half");
  });
});
