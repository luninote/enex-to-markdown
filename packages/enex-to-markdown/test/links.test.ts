import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ConvertOptions, convertEnex, WARNINGS_FILE } from "../src/convert.ts";
import { enex, md5, type NoteSpec, read, tempDir } from "./enex.ts";

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

async function writeEnex(name: string, notes: (NoteSpec | string)[]): Promise<void> {
  const path = join(dir, "in", name);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, enex(notes));
}

async function run(opts: Partial<ConvertOptions> = {}) {
  const out = join(dir, "out");
  const summary = await convertEnex([join(dir, "in")], { outDir: out, ...opts });
  const report = await read(join(out, WARNINGS_FILE)).catch(() => "");
  return { out, summary, report, md: (p: string) => read(join(out, p)) };
}

describe("links to notes that share a title", () => {
  it("prefers the note in the same notebook, then in the same folder, and lists each choice", async () => {
    await writeEnex("Work/Projects.enex", [
      { title: "Plan" },
      { title: "Kickoff", body: `<div>${link("Plan")} and ${link("Budget")}</div>` },
    ]);
    await writeEnex("Work/Money.enex", [{ title: "Budget" }]);
    await writeEnex("Home/Garden.enex", [{ title: "Plan" }, { title: "Budget" }]);
    const { md, report, summary } = await run();
    const text = await md("Work/Projects/Kickoff.md");
    expect(text).toContain("[Plan](<Plan.md>)");
    expect(text).toContain("[Budget](<../Money/Budget.md>)");
    expect(report).toContain('the one in the same notebook was used.\n      "Plan" -> Work/Projects/Plan.md');
    expect(report).toContain('the one in the same folder (stack) was used.\n      "Budget" -> Work/Money/Budget.md');
    expect(summary.linksInferred).toBe(2);
  });

  it("leaves a link that stays ambiguous pointing to Evernote and names every candidate", async () => {
    await writeEnex("A.enex", [{ title: "Notes" }, { title: "Index", body: `<div>${link("Notes", GUID(1))}</div>` }]);
    await writeEnex("B.enex", [{ title: "Notes" }]);
    await writeEnex("C.enex", [{ title: "Notes" }]);
    // A link from a notebook that has none of them can't choose. Nor can it follow A's link to the same Evernote
    // note: that one was a choice between namesakes too.
    await writeEnex("D.enex", [
      { title: "From D", body: `<div>${link("Notes", GUID(2))} ${link("Notes", GUID(1))}</div>` },
    ]);
    const { md, report, summary } = await run();
    expect(await md("A/Index.md")).toContain("[Notes](<Notes.md>)");
    expect(await md("D/From D.md")).toContain("[Notes](<evernote:///view/");
    expect(report).toContain('"Notes": A/Notes.md, B/Notes.md, C/Notes.md');
    expect(summary.linksLeft).toBe(2);
  });
});

describe("links whose text isn't the exact title", () => {
  it("matches ignoring case, accents, spaces and punctuation when only one title fits, and lists it", async () => {
    await writeEnex("Work.enex", [
      { title: "Budget 2024 – Café" },
      { title: "Source", body: `<div>${link("budget  2024 cafe!")}</div>` },
    ]);
    const { md, report } = await run();
    expect(await md("Work/Source.md")).toContain("](<Budget%202024%20%E2%80%93%20Caf%C3%A9.md>)");
    expect(report).toContain("only when ignoring case");
    expect(report).toContain('"budget 2024 cafe!" -> Work/Budget 2024 – Café.md');
  });

  it("doesn't guess when two titles match loosely", async () => {
    await writeEnex("Work.enex", [
      { title: "Budget-2024" },
      { title: "budget 2024" },
      { title: "Source", body: `<div>${link("BUDGET 2024!")}</div>` },
    ]);
    const { md, report } = await run();
    expect(await md("Work/Source.md")).toContain("(<evernote:///");
    expect(report).toContain('"BUDGET 2024!": Work/Budget-2024.md, Work/budget 2024.md');
  });

  it("follows another link to the same Evernote note when that one matched by title (a renamed note)", async () => {
    await writeEnex("Work.enex", [
      { title: "Roadmap 2025" },
      { title: "Old", body: `<div>${link("Roadmap draft", GUID(5))}</div>` },
      { title: "New", body: `<div>${link("Roadmap 2025", GUID(5))}</div>` },
      { title: "Unrelated", body: `<div>${link("Roadmap draft", GUID(6))}</div>` },
    ]);
    const { md, report } = await run();
    expect(await md("Work/Old.md")).toContain("[Roadmap draft](<Roadmap%202025.md>)");
    expect(await md("Work/Unrelated.md")).toContain("(<evernote:///");
    expect(report).toContain(
      'another link to the same Evernote note matched one; that note was used.\n      "Roadmap draft" -> Work/Roadmap 2025.md',
    );
  });

  it("ignores other links that disagree about the note", async () => {
    await writeEnex("Work.enex", [
      { title: "Alpha" },
      { title: "Beta" },
      { title: "One", body: `<div>${link("Alpha", GUID(7))} ${link("Beta", GUID(7))} ${link("Gamma", GUID(7))}</div>` },
    ]);
    const { md } = await run();
    expect(await md("Work/One.md")).toContain("[Gamma](<evernote:///");
  });

  it("matches a close title only with --fuzzy-links, and lists it as a warning", async () => {
    const notes = [{ title: "Quarterly report" }, { title: "Source", body: `<div>${link("Quartely report")}</div>` }];
    await writeEnex("Work.enex", notes);
    expect(await (await run()).md("Work/Source.md")).toContain("(<evernote:///");
    const fuzzy = await run({ fuzzyLinks: true, overwrite: true });
    expect(await fuzzy.md("Work/Source.md")).toContain("[Quartely report](<Quarterly%20report.md>)");
    expect(fuzzy.report).toContain("closest title (--fuzzy-links)");
    expect(fuzzy.report).toContain('"Quartely report" -> Work/Quarterly report.md');
  });
});

describe("other kinds of note links", () => {
  it("matches share.evernote.com/note/ and evernote.com/shard/…/nl/ links by title too", async () => {
    const g = GUID(3);
    await writeEnex("Work.enex", [
      { title: "Target" },
      {
        title: "Source",
        body: `<div><a href="https://share.evernote.com/note/${g}">Target</a> <a href="https://www.evernote.com/shard/s1/nl/111/${g}/">Target</a></div>`,
      },
    ]);
    const { md, summary } = await run();
    expect(await md("Work/Source.md")).toContain("[Target](<Target.md>) [Target](<Target.md>)");
    expect(summary.linksRewritten).toBe(2);
  });

  it("uses the note GUIDs evernote-backup --add-guid writes (after the resources and tasks)", async () => {
    const png = Buffer.from("not really a png");
    // The shape evernote-backup writes: <guid> as a direct child of <note>, after <resource> and <task>.
    const target = `<note><title>Renamed later</title><created>20240101T000000Z</created><updated>20240101T000000Z</updated><content><![CDATA[<en-note><div>x</div><en-media hash="${md5(png)}" type="image/png"/></en-note>]]></content><resource><data encoding="base64">${png.toString("base64")}</data><mime>image/png</mime></resource><guid>${GUID(8)}</guid></note>`;
    const meta = `<note><title>Also renamed</title><created>20240101T000000Z</created><content><![CDATA[<en-note/>]]></content><note-custom-metadata><guid>${GUID(9)}</guid><notebook-name>Work</notebook-name></note-custom-metadata></note>`;
    await writeEnex("Work.enex", [
      target,
      meta,
      { title: "Source", body: `<div>${link("Original title", GUID(8))} ${link("Other", GUID(9))}</div>` },
    ]);
    const { md, report, summary } = await run();
    expect(await md("Work/Source.md")).toContain("[Original title](<Renamed%20later.md>) [Other](<Also%20renamed.md>)");
    expect(summary.linksInferred).toBe(0);
    expect(report).not.toContain("Source.md");
  });
});
