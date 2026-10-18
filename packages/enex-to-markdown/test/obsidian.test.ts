import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { convertEnex, WARNINGS_FILE } from "../src/convert.ts";
import { enex, md5, type NoteSpec, read, tempDir } from "./enex.ts";

const GUID = (n: number) => `0a1b2c3d-0000-4000-8000-${String(n).padStart(12, "0")}`;
const link = (text: string, n = 999) => `<a href="evernote:///view/111/s1/${GUID(n)}/${GUID(n)}/">${text}</a>`;
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const PDF = Buffer.from("%PDF-1.4 tiny");
const ZIP = Buffer.from("PK zip");

const task = (title: string, extra: string, status = "open", flag = false) =>
  `<task><title>${title}</title><created>20240101T000000Z</created><updated>20240101T000000Z</updated><taskStatus>${status}</taskStatus><taskFlag>${flag}</taskFlag><sortWeight>${title}</sortWeight><noteLevelID>${title}</noteLevelID><taskGroupNoteLevelID>g1</taskGroupNoteLevelID>${extra}</task>`;

let dir: string;
let done: () => Promise<void>;
beforeEach(async () => {
  ({ path: dir, done } = await tempDir());
});
afterEach(async () => {
  await done();
});

async function convert(files: Record<string, (NoteSpec | string)[]>) {
  for (const [name, notes] of Object.entries(files)) {
    await mkdir(join(dir, "in", name, ".."), { recursive: true });
    await writeFile(join(dir, "in", name), enex(notes));
  }
  const out = join(dir, "out");
  const summary = await convertEnex([join(dir, "in")], { outDir: out, obsidian: true });
  return {
    summary,
    out,
    md: (p: string) => read(join(out, p)),
    report: () => read(join(out, WARNINGS_FILE)).catch(() => ""),
  };
}

describe("--obsidian", () => {
  it("writes [[wikilinks]] by name, by path when names repeat, with the link text as alias when it differs", async () => {
    const { md } = await convert({
      "Work.enex": [
        { title: "Plan" },
        { title: "Budget" },
        {
          title: "Index",
          body: `<div>${link("Plan", 1)}, ${link("<b>budget</b>", 2)} and ${link("Recipe", 3)}</div>`,
        },
      ],
      "Home.enex": [{ title: "Plan" }, { title: "Recipe" }],
    });
    const text = await md("Work/Index.md");
    expect(text).toContain("[[Work/Plan]], <strong>[[Budget|budget]]</strong> and [[Recipe]]");
  });

  it("embeds attachments with ![[path]] (sized when the note sizes them) and links other files", async () => {
    const { md } = await convert({
      "Work.enex": [
        {
          title: "Files",
          body: `<div><en-media hash="${md5(PNG)}" type="image/png" width="300"/></div><div><en-media hash="${md5(PDF)}" type="application/pdf"/></div><div><en-media hash="${md5(ZIP)}" type="application/zip"/></div>`,
          resources: [
            { data: PNG, mime: "image/png", fileName: "scan #1.png" },
            { data: PDF, mime: "application/pdf", fileName: "doc.pdf" },
            { data: ZIP, mime: "application/zip", fileName: "bundle.zip" },
          ],
        },
      ],
    });
    const text = await md("Work/Files.md");
    expect(text).toContain("![[Work/_resources/Files/scan _1.png|300]]");
    expect(text).toContain("![[Work/_resources/Files/doc.pdf]]");
    expect(text).toContain("[[Work/_resources/Files/bundle.zip]]");
  });

  it("writes ==highlights==, escapes what Obsidian would read as math or a highlight, drops the title heading", async () => {
    const { md } = await convert({
      "Work.enex": [
        { title: "Marks", body: `<div><span style="--en-highlight:yellow">key</span> costs $5 and a==b</div>` },
      ],
    });
    const text = await md("Work/Marks.md");
    expect(text).toContain("==key== costs \\$5 and a\\==b");
    expect(text).not.toContain("# Marks");
  });

  it("writes Evernote Tasks in the Tasks plugin's format and lists what the format can't hold", async () => {
    const { md, report } = await convert({
      "Work.enex": [
        {
          title: "Todo",
          body: `<div style="--en-task-group:true; --en-id:g1;"></div>`,
          extra:
            task(
              "A",
              "<dueDate>20240110T225959Z</dueDate><dueDateUIOption>date_only</dueDateUIOption><timeZone>Europe/Berlin</timeZone><recurrence>DTSTART;TZID=Europe/Berlin:20240110T235959\\nRRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR</recurrence><repeatAfterCompletion>true</repeatAfterCompletion><reminder><reminderDate>20240109T070000Z</reminderDate><reminderDateUIOption>date_time</reminderDateUIOption><reminderStatus>active</reminderStatus></reminder>",
              "open",
              true,
            ) +
            task("B", "<statusUpdated>20240111T120000Z</statusUpdated>", "completed") +
            task("C", "<dueDate>20240301T150000Z</dueDate><dueDateUIOption>date_time</dueDateUIOption>"),
        },
      ],
    });
    const text = await md("Work/Todo.md");
    expect(text).toContain("- [ ] A ⏫ 🔁 every 2 weeks on Monday, Friday when done ⏳ 2024-01-09 📅 2024-01-10");
    expect(text).toContain("- [x] B ✅ 2024-01-11");
    expect(text).toContain("- [ ] C 📅 2024-03-01");
    const r = await report();
    expect(r).toContain('"A": time of day (reminder 08:00)');
    expect(r).toContain('"C": time of day (due 15:00)');
  });

  it("makes tags Obsidian accepts, lists the renamed ones, and keeps the title as an alias when the name differs", async () => {
    const { md, out, report } = await convert({
      "Work #1.enex": [{ title: "a/b [draft]", tags: ["to read", "2025", "c++", "ok_tag"] }],
    });
    expect(existsSync(join(out, "Work _1"))).toBe(true);
    const text = await md("Work _1/a_b _draft_.md");
    expect(text).toContain('aliases:\n  - "a/b [draft]"');
    expect(text).toContain('tags:\n  - "to-read"\n  - "_2025"\n  - "c__"\n  - "ok_tag"');
    const r = await report();
    expect(r).toContain('"to read" is now #to-read');
    expect(r).not.toContain("ok_tag");
  });
});
