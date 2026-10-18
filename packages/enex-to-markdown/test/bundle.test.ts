import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import vm from "node:vm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { InputFile } from "../src/browser/protocol.ts";
import { findEnexFiles } from "../src/convert.ts";
import { encryptAes } from "./encrypt.ts";
import { enex, tempDir } from "./enex.ts";
import { readTree, readZip, treeDiff } from "./trees.ts";

const run = promisify(execFile);
const pkg = join(import.meta.dirname, "..");
const fixture = join(import.meta.dirname, "fixtures", "Travel.enex");

// The published package is the single bundled file: build it outside the repo, where no workspace package or
// node_modules folder can be found, and run it the way a user would.
describe("the bundled command", () => {
  let dir: string;
  let done: () => Promise<void>;
  beforeAll(async () => {
    ({ path: dir, done } = await tempDir());
    await run(process.execPath, [join(pkg, "build.mjs"), "--outdir", join(dir, "dist")]);
  }, 120_000);
  afterAll(async () => {
    await done();
  });

  it("converts an ENEX file end to end", async () => {
    const out = join(dir, "out");
    const { stdout } = await run(process.execPath, [join(dir, "dist", "cli.js"), fixture, "-o", out, "-q"], {
      cwd: dir,
    });
    expect(stdout).toContain("Converted 3 notes from 1 notebook");
    expect(stdout).toContain("Attachments: 2");
    expect(stdout).toContain("Links between notes rewritten: 1");
    const plan = await readFile(join(out, "Travel", "Trip plan.md"), "utf8");
    expect(plan).toContain('title: "Trip plan"');
    expect(plan).toContain("- [x] Book the train");
    expect(plan).toContain("[Packing list](<Packing%20list.md>)");
    expect(plan).toContain("| Day | City |");
    expect(plan).toContain("![map: day 1.png](<_resources/Trip%20plan/map_%20day%201.png>)");
    expect(existsSync(join(out, "Travel", "Trip plan (2).md"))).toBe(true);
    expect(await readFile(join(out, "Travel", "_resources", "Packing list", "list.txt"), "utf8")).toBe(
      "Packing list for the trip.\n",
    );
    expect(await readFile(join(out, "conversion-warnings.txt"), "utf8")).toContain("hint: the usual");
    expect(existsSync(join(dir, "dist", "THIRD-PARTY-LICENSES.txt"))).toBe(true);
  });

  it("runs --obsidian with a password, a dry run and split exports end to end", async () => {
    const guid = "0a1b2c3d-0000-4000-8000-000000000001";
    const secret = encryptAes("<div>vault code 4711</div>", "open sesame");
    const input = join(dir, "in");
    await mkdir(input, { recursive: true });
    await writeFile(
      join(input, "Work (1).enex"),
      enex([{ title: "Plan", extra: `<guid>${guid}</guid>` }, { title: "Note one" }]),
    );
    await writeFile(
      join(input, "Work (2).enex"),
      enex([
        {
          title: "Index",
          body: `<div><a href="evernote:///view/1/s1/${guid}/${guid}/">the plan</a></div><en-crypt cipher="AES" length="128">${secret}</en-crypt>`,
        },
      ]),
    );
    const cli = join(dir, "dist", "cli.js");
    const out = join(dir, "obsidian");

    const dry = await run(process.execPath, [cli, input, "-o", out, "-q", "--dry-run"], { cwd: dir });
    expect(dry.stdout).toContain("Dry run: read 3 notes from 1 notebook");
    expect(existsSync(join(out, "Work"))).toBe(false);

    const { stdout } = await run(
      process.execPath,
      [cli, input, "-o", out, "-q", "--obsidian", "--password", "wrong", "--password", "open sesame"],
      { cwd: dir },
    );
    expect(stdout).toContain("Encrypted blocks decrypted: 1");
    expect(stdout).not.toContain("open sesame");
    const index = await readFile(join(out, "Work", "Index.md"), "utf8");
    expect(index).toContain("[[Plan|the plan]]");
    expect(index).toContain("vault code 4711");
    expect(existsSync(join(out, "Work", "Note one.md"))).toBe(true);
  });

  it("exits with a usage error and help when given nothing", async () => {
    const err = await run(process.execPath, [join(dir, "dist", "cli.js")]).catch((e) => e);
    expect(err.code).toBe(2);
    expect(err.stderr).toContain("Usage:");
  });
});

// The browser build is one classic worker script. Node has what it needs (File, streams, Response, WebCrypto), so it
// runs here as it is, with its own Buffer and hash shims, through the same messages a page sends.
describe("the bundled browser worker", () => {
  let dir: string;
  let done: () => Promise<void>;
  let code: string;
  beforeAll(async () => {
    ({ path: dir, done } = await tempDir());
    await run(process.execPath, [join(pkg, "build.mjs"), "--outdir", join(dir, "dist")]);
    code = await readFile(join(dir, "dist", "browser", "enex-to-markdown-worker.js"), "utf8");
  }, 120_000);
  afterAll(async () => {
    await done();
  });

  type Message = { type: string; [k: string]: unknown };
  const g = globalThis as unknown as {
    onmessage: ((e: { data: unknown }) => void) | null;
    postMessage?: (m: Message) => void;
  };

  async function start(files: InputFile[], options: object, cancel = false): Promise<Message[]> {
    const messages: Message[] = [];
    const finished = new Promise<void>((resolve) => {
      g.postMessage = (m) => {
        messages.push(m);
        if (m.type !== "progress") resolve();
      };
    });
    vm.runInThisContext(code);
    g.onmessage?.({ data: { type: "start", files, options, target: null } });
    if (cancel) g.onmessage?.({ data: { type: "cancel" } });
    await finished;
    g.onmessage = null;
    delete g.postMessage;
    return messages;
  }

  async function inputsOf(paths: string[]): Promise<InputFile[]> {
    const out: InputFile[] = [];
    for (const f of await findEnexFiles(paths))
      out.push({ file: new File([await readFile(f.path)], basename(f.path)), relDir: f.relDir, label: f.path });
    return out;
  }

  it("writes a ZIP holding exactly what the command line writes", async () => {
    await run(process.execPath, [join(pkg, "bench", "make-inputs.mjs"), join(dir, "inputs")]);
    for (const [set, paths] of [
      ["Travel", [fixture]],
      ["stress", [join(dir, "inputs", "stress")]],
    ] as const) {
      // The worker shortens long names for an output folder 64 characters long; give the command line one too.
      const base = join(dir, set);
      const out = join(base, "x".repeat(64 - base.length - 1));
      expect(out.length).toBe(64);
      const options = { obsidian: true, passwords: ["bench-pass"] };
      await run(process.execPath, [
        join(dir, "dist", "cli.js"),
        ...paths,
        "-o",
        out,
        "-q",
        "--obsidian",
        "--password",
        "bench-pass",
      ]);
      const messages = await start(await inputsOf([...paths]), options);
      const last = messages.at(-1) as { type: string; zip: Blob; warnings: string | null; summary: { notes: number } };
      expect(last.type, JSON.stringify(last)).toBe("done");
      const zip = readZip(new Uint8Array(await last.zip.arrayBuffer()));
      const files = new Map([...zip].map(([name, f]) => [name, f.bytes]));
      expect(treeDiff(readTree(out), files), set).toEqual([]);
      expect(last.warnings).toBe(await readFile(join(out, "conversion-warnings.txt"), "utf8"));
      expect(messages.some((m) => m.type === "progress")).toBe(true);
    }
  }, 120_000);

  it("stops when cancelled and says so", async () => {
    const messages = await start(await inputsOf([fixture]), {}, true);
    expect(messages.at(-1)?.type).toBe("cancelled");
  });

  it("has no way to send anything: no fetch, XHR, sockets, beacons or script loading", () => {
    expect(code).not.toMatch(
      /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|\bimport\s*\(/,
    );
  });
});
