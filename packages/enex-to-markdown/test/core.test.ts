import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Writable } from "node:stream";
import { promisify } from "node:util";
import { HAS_YARLE, YARLE } from "@luninote/enml/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ConvertOptions, convertEnex, findEnexFiles } from "../src/convert.ts";
import { convertSources, type EnexSource, type Output, type Staged } from "../src/core.ts";
import { tempDir } from "./enex.ts";
import { readTree, treeDiff } from "./trees.ts";

const run = promisify(execFile);
const pkg = join(import.meta.dirname, "..");

/** Holds everything in memory; attachments wait in Writables that keep their chunks, as a browser would. */
class MemoryOutput implements Output {
  readonly files = new Map<string, Uint8Array>();
  readonly mtimes = new Map<string, number>();
  private readonly staged = new Map<Staged, Buffer[]>();

  stage(): Staged {
    const chunks: Buffer[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _enc, done) {
        chunks.push(chunk);
        done();
      },
    });
    this.staged.set(sink, chunks);
    return sink;
  }

  async commit(staged: Staged, path: string): Promise<void> {
    this.files.set(path, Buffer.concat(this.staged.get(staged) ?? []));
    this.staged.delete(staged);
  }

  async discard(staged: Staged): Promise<void> {
    this.staged.delete(staged);
  }

  async dir(path: string): Promise<void> {
    this.files.set(`${path}/`, new Uint8Array(0));
  }

  async write(path: string, data: string | Uint8Array, mtime: Date | null): Promise<void> {
    this.files.set(path, typeof data === "string" ? Buffer.from(data) : data);
    if (mtime) this.mtimes.set(path, mtime.getTime());
  }

  /** As a folder holds it: a file's parent folders exist too. */
  tree(): Map<string, Uint8Array> {
    const out = new Map(this.files);
    for (const path of this.files.keys()) {
      const parts = path.split("/").slice(0, -1);
      for (let k = 1; k <= parts.length; k++) out.set(`${parts.slice(0, k).join("/")}/`, new Uint8Array(0));
    }
    return out;
  }
}

async function sourcesFor(inputs: string[]): Promise<EnexSource[]> {
  const { createReadStream } = await import("node:fs");
  const out: EnexSource[] = [];
  for (const f of await findEnexFiles(inputs))
    out.push({
      name: f.path.slice(f.path.lastIndexOf(f.path.includes("\\") ? "\\" : "/") + 1),
      label: f.path,
      relDir: f.relDir,
      size: (await stat(f.path)).size,
      // Small pieces, so notes and attachments cross piece boundaries often.
      open: () => createReadStream(f.path, { highWaterMark: 4096 }),
    });
  return out;
}

const OPTION_SETS: [string, Partial<ConvertOptions>][] = [
  ["defaults, a password", { passwords: ["bench-pass"] }],
  ["Obsidian", { obsidian: true, passwords: ["bench-pass"] }],
  [
    "everything else",
    { frontMatter: "full", datePrefix: true, keepColors: true, fuzzyLinks: true, keepClipHtml: true },
  ],
  ["split parts apart, no front matter", { mergeParts: false, frontMatter: "none" }],
];

let dir: string;
let done: () => Promise<void>;
let stress: string;
beforeAll(async () => {
  ({ path: dir, done } = await tempDir());
  await run(process.execPath, [join(pkg, "bench", "make-inputs.mjs"), join(dir, "inputs")]);
  stress = join(dir, "inputs", "stress");
}, 60_000);
afterAll(async () => {
  await done();
});

describe("the core with an in-memory output", () => {
  const inputs = () => [
    ["Travel", [join(pkg, "test", "fixtures", "Travel.enex")]],
    ["stress", [stress]],
    ...(HAS_YARLE ? [["Yarle's test files", [YARLE]]] : []),
  ];

  it.each(OPTION_SETS)(
    "writes what the command line writes (%s)",
    async (label, options) => {
      for (const [set, paths] of inputs() as [string, string[]][]) {
        const out = join(dir, "cli", label.replace(/\W+/g, "-"), set);
        const cli = await convertEnex(paths, { ...options, outDir: out });
        const memory = new MemoryOutput();
        const core = await convertSources(await sourcesFor(paths), memory, {
          ...options,
          rootLength: resolve(out).length,
        });
        const cliTree = readTree(out);
        expect(treeDiff(cliTree, memory.tree()), `${set}, ${label}`).toEqual([]);
        expect(cliTree.size).toBeGreaterThan(3);
        expect({ ...core, outDir: "", warningsFile: null }).toEqual({ ...cli, outDir: "", warningsFile: null });
        for (const [path, time] of memory.mtimes)
          expect((await stat(join(out, path))).mtimeMs, path).toBeCloseTo(time, -3);
      }
    },
    60_000,
  );

  it("stops at the next note when cancelled, without turning the cancel into a warning", async () => {
    const controller = new AbortController();
    const memory = new MemoryOutput();
    let notes = 0;
    const pending = convertSources(await sourcesFor([stress]), memory, {
      rootLength: 40,
      signal: controller.signal,
      onProgress: (p) => {
        notes = p.notes;
        if (p.phase === "convert" && p.notes === 2) controller.abort();
      },
    });
    await expect(pending).rejects.toThrow(/abort/i);
    expect(notes).toBe(2);
    expect(memory.files.has("conversion-warnings.txt")).toBe(false);
  });

  it("reports progress through both passes, ending at the input's size twice", async () => {
    const seen: { phase: string; bytes: number; totalBytes: number }[] = [];
    const sources = await sourcesFor([join(pkg, "test", "fixtures", "Travel.enex")]);
    await convertSources(sources, new MemoryOutput(), { rootLength: 40, onProgress: (p) => seen.push(p) });
    const size = (await readFile(join(pkg, "test", "fixtures", "Travel.enex"))).length;
    expect(seen.map((p) => p.phase)).toEqual(["scan", "scan", "scan", "convert", "convert", "convert"]);
    expect(seen.every((p) => p.totalBytes === 2 * size)).toBe(true);
    expect(seen.map((p) => p.bytes)).toEqual([...seen.map((p) => p.bytes)].sort((a, b) => a - b));
    expect(seen.at(-1)?.bytes).toBeLessThanOrEqual(2 * size);
    expect(seen.at(-1)?.bytes).toBeGreaterThan(size);
  });
});
