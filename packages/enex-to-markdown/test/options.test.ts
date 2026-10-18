import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ConvertOptions, convertEnex, WARNINGS_FILE } from "../src/convert.ts";
import { encryptAes, encryptRc2 } from "./encrypt.ts";
import { enex, md5, type NoteSpec, read, tempDir } from "./enex.ts";

let dir: string;
let done: () => Promise<void>;
beforeEach(async () => {
  ({ path: dir, done } = await tempDir());
});
afterEach(async () => {
  await done();
});

async function put(name: string, notes: (NoteSpec | string)[] | Buffer | string): Promise<string> {
  const path = join(dir, "in", name);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, Array.isArray(notes) ? enex(notes) : notes);
  return path;
}

async function run(opts: Partial<ConvertOptions> = {}, inputs = [join(dir, "in")]) {
  const out = opts.outDir ?? join(dir, "out");
  const summary = await convertEnex(inputs, { outDir: out, ...opts });
  return {
    out,
    summary,
    md: (p: string) => read(join(out, p)),
    report: () => read(join(out, WARNINGS_FILE)).catch(() => ""),
  };
}

describe("split exports", () => {
  it("puts Work.enex, Work (1).enex and Work (2).enex in one Work folder, names unique across them", async () => {
    await put("Work.enex", [{ title: "Plan" }]);
    await put("Work (1).enex", [{ title: "Plan" }, { title: "Two" }]);
    await put("Work (2).enex", [{ title: "Three", body: `<div><a href="evernote:///view/1/s1/x/x/">Two</a></div>` }]);
    await put("Alone (1).enex", [{ title: "Solo" }]);
    const { out, summary, md } = await run();
    expect((await readdir(join(out, "Work"))).sort()).toEqual(["Plan (2).md", "Plan.md", "Three.md", "Two.md"]);
    expect(existsSync(join(out, "Alone (1)", "Solo.md"))).toBe(true);
    expect(summary.notebooks).toBe(2);
    expect(await md("Work/Three.md")).toContain("[Two](<Two.md>)");
  });

  it("keeps the parts apart with mergeParts off", async () => {
    await put("Work.enex", [{ title: "A" }]);
    await put("Work (1).enex", [{ title: "B" }]);
    const { out } = await run({ mergeParts: false });
    expect(existsSync(join(out, "Work (1)", "B.md"))).toBe(true);
  });
});

describe("long paths", () => {
  it("shortens names that would make a path too long, the same way every run, and lists them", async () => {
    const long = `${"A very long note title that keeps going ".repeat(4)}end`;
    const png = Buffer.from("png bytes");
    await put("Notebook.enex", [
      {
        title: long,
        body: `<div><en-media hash="${md5(png)}" type="image/png"/></div>`,
        resources: [{ data: png, mime: "image/png", fileName: `${"picture ".repeat(10)}.png` }],
      },
      { title: `${long} two` },
    ]);
    const out = join(dir, "o");
    const max = out.length + 90;
    const { summary, report } = await run({ outDir: out, maxPath: max });
    const files = await readdir(join(out, "Notebook"));
    const notes = files.filter((f) => f.endsWith(".md"));
    expect(notes).toHaveLength(2);
    for (const f of notes) expect(join(out, "Notebook", f).length).toBeLessThanOrEqual(max);
    expect(notes.every((f) => /~[0-9a-f]{6}\.md$/.test(f))).toBe(true);
    const resDir = (await readdir(join(out, "Notebook", "_resources")))[0] as string;
    const [pic] = await readdir(join(out, "Notebook", "_resources", resDir));
    expect(join(out, "Notebook", "_resources", resDir, pic as string).length).toBeLessThanOrEqual(max);
    expect(await report()).toContain("shortened to keep the full path under the length Windows allows");
    expect(summary.notes).toBe(2);
    const again = await run({ outDir: join(dir, "p"), maxPath: max });
    expect((await readdir(join(again.out, "Notebook"))).filter((f) => f.endsWith(".md")).sort()).toEqual(notes.sort());
  });
});

describe("file names and front matter", () => {
  it("prefixes names with the creation date and writes each front matter level", async () => {
    await put("Work.enex", [
      {
        title: "Trip",
        tags: ["travel"],
        attributes: {
          "source-url": "https://example.com",
          author: "Someone",
          latitude: "47.5",
          longitude: "19.04",
          "reminder-time": "20240105T090000Z",
          "subject-date": "20231231T000000Z",
          source: "mobile.android",
        },
      },
    ]);
    const full = await run({ datePrefix: true, frontMatter: "full" });
    const text = await full.md("Work/2024-01-02 Trip.md");
    expect(text).toContain('source: "https://example.com"');
    expect(text).toContain("reminder: 2024-01-05T09:00:00Z");
    expect(text).toContain("location: [47.5, 19.04]");
    expect(text).toContain("subject-date: 2023-12-31T00:00:00Z");
    expect(text).toContain('source-app: "mobile.android"');
    const minimal = await (await run({ outDir: join(dir, "m"), frontMatter: "minimal" })).md("Work/Trip.md");
    expect(minimal).toContain('tags:\n  - "travel"');
    expect(minimal).not.toContain("source:");
    expect(minimal).not.toContain("location");
    const standard = await (await run({ outDir: join(dir, "s") })).md("Work/Trip.md");
    expect(standard).toContain("reminder: 2024-01-05T09:00:00Z");
    expect(standard).not.toContain("location");
    const none = await (await run({ outDir: join(dir, "n"), frontMatter: "none" })).md("Work/Trip.md");
    expect(none.startsWith("# Trip\n")).toBe(true);
  });
});

describe("dry run", () => {
  it("writes only the warnings file, and a real run can follow in the same folder", async () => {
    await put("Work.enex", [
      { title: "Gone link", body: `<div><a href="evernote:///view/1/s1/x/x/">Nowhere</a></div>` },
      { title: "Fine" },
    ]);
    const dry = await run({ dryRun: true });
    expect(await readdir(dry.out)).toEqual([WARNINGS_FILE]);
    const report = await dry.report();
    expect(report).toContain("Dry run: nothing was converted");
    expect(report).toContain('"Nowhere"');
    expect(dry.summary.notes).toBe(2);
    const real = await run();
    expect(existsSync(join(real.out, "Work", "Fine.md"))).toBe(true);
  });
});

describe("encodings", () => {
  it("reads UTF-16 files and files in a declared single-byte encoding", async () => {
    const xml = enex([{ title: "Grüße – ½", body: "<div>Ünïcödé text</div>" }]);
    await put("Utf16.enex", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, "utf16le")]));
    const latin = xml.replace('encoding="UTF-8"', 'encoding="ISO-8859-1"').replace(" – ½", " ½");
    await put("Latin.enex", Buffer.from(latin, "latin1"));
    const { md, report } = await run();
    expect(await md("Utf16/Grüße – ½.md")).toContain("Ünïcödé text");
    expect(await md("Latin/Grüße ½.md")).toContain("Ünïcödé text");
    expect(await report()).toContain("it was read in the encoding it declares");
  });

  it("reads stray Windows-1252 bytes in a UTF-8 file as Windows-1252, and says so", async () => {
    const xml = Buffer.from(enex([{ title: "Quotes", body: "<div>it’s QUOTE and café</div>" }]), "utf8");
    // Replace QUOTE with Windows-1252 curly quotes and an e-acute: invalid as UTF-8.
    const at = xml.indexOf("QUOTE");
    const bad = Buffer.concat([xml.subarray(0, at), Buffer.from([0x93, 0x45, 0xe9, 0x94]), xml.subarray(at + 5)]);
    await put("Mixed.enex", bad);
    const { md, report } = await run();
    expect(await md("Mixed/Quotes.md")).toContain("it’s “Eé” and café");
    expect(await report()).toContain("weren't valid UTF-8. They were read as Windows-1252");
  });
});

describe("encrypted text", () => {
  it("decrypts with the passwords given and keeps what no password opens", async () => {
    await put("Work.enex", [
      {
        title: "Secrets",
        body: `<div>PIN: <en-crypt hint="dog" cipher="AES" length="128">${encryptAes("<b>4711</b>", "rex")}</en-crypt></div><div>Old: <en-crypt cipher="RC2" length="64">${encryptRc2("legacy text", "rex")}</en-crypt></div><div>Other: <en-crypt hint="cat" cipher="AES" length="128">${encryptAes("hidden", "tom")}</en-crypt></div>`,
      },
    ]);
    const { md, report, summary } = await run({ passwords: ["wrong", "rex"] });
    const text = await md("Work/Secrets.md");
    expect(text).toContain("PIN: **4711**");
    expect(text).toContain("Old: legacy text");
    expect(text).toContain('Other: <span class="encrypted"');
    expect(summary.decrypted).toBe(2);
    const r = await report();
    expect(r).toContain("decrypted with a password you gave");
    expect(r).toContain("couldn't be opened with the passwords given");
    expect(r).toContain("hint: cat");
    expect(r).not.toContain("rex");
  });
});

describe("content", () => {
  it("keeps the language of code blocks", async () => {
    await put("Work.enex", [
      {
        title: "Code",
        body:
          '<div style="--en-codeblock:true; --en-syntaxLanguage:python;"><div>print(1)</div></div>' +
          '<pre><code class="language-rust">fn main() {}</code></pre>' +
          '<div style="--en-codeblock:true;"><div>plain</div></div>',
      },
    ]);
    const text = await (await run()).md("Work/Code.md");
    expect(text).toContain("```python\nprint(1)\n```");
    expect(text).toContain("```rust\nfn main() {}\n```");
    expect(text).toContain("```\nplain\n```");
  });

  it("keeps tables with lists, code, line breaks and images in cells as Markdown tables", async () => {
    const png = Buffer.from("img");
    await put("Work.enex", [
      {
        title: "Table",
        body: `<table><tr><th>What</th><th>Items</th></tr><tr><td>a<br/>b</td><td><ul><li>one</li><li>two | three</li></ul></td></tr><tr><td><en-media hash="${md5(png)}" type="image/png"/></td><td><div style="--en-codeblock:true;"><div>x | y</div></div></td></tr></table>`,
        resources: [{ data: png, mime: "image/png", fileName: "pic.png" }],
      },
    ]);
    const text = await (await run()).md("Work/Table.md");
    expect(text).toContain("| What | Items |\n| --- | --- |");
    expect(text).toContain("| a<br>b | <ul><li>one</li><li>two \\| three</li></ul> |");
    expect(text).toContain("| ![pic.png](<_resources/Table/pic.png>) | <code>x \\| y</code> |");
  });
});
