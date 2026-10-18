// Runs enex-to-markdown, Yarle and evernote2md on the same ENEX files and scores each output. Windows with
// PowerShell 7 (pwsh), for the memory measurement. See README.md in this folder for the method.
//
//   node bench/run.mjs --work <scratch folder> --inputs <folder from make-inputs.mjs> \
//     --yarle <folder Yarle is installed in> --evernote2md <evernote2md.exe> [--corpus <folder of .enex files>] \
//     [--sets corpus,stress,big,huge] [--cli <path to dist/cli.js>]
//   node bench/run.mjs --work <same folder> --inputs <same folder> --rescore
//
// Downloaded tools are run from their own folders with paths as arguments; nothing is run from the inputs.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { score, walk } from "./score.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
  options: {
    work: { type: "string" },
    inputs: { type: "string" },
    corpus: { type: "string" },
    yarle: { type: "string" },
    evernote2md: { type: "string" },
    cli: { type: "string" },
    sets: { type: "string", default: "corpus,stress" },
    keep: { type: "boolean" },
    rescore: { type: "boolean" },
  },
});
for (const k of values.rescore ? ["work", "inputs"] : ["work", "inputs", "yarle", "evernote2md"])
  if (!values[k]) {
    console.error(`--${k} is required`);
    process.exit(2);
  }

const PASSWORD = "bench-pass";
const work = resolve(values.work);
const cli = resolve(values.cli ?? join(here, "..", "dist", "cli.js"));
const yarleDir = join(resolve(values.yarle ?? "."), "node_modules", "yarle-evernote-to-md");
const yarleCli = join(yarleDir, "dist", "dropTheRope.js");
const e2md = resolve(values.evernote2md ?? ".");

/** A folder with every .enex file of `from` (subfolders included) side by side: Yarle reads one folder level. */
function flatCopy(from, to) {
  rmSync(to, { recursive: true, force: true });
  mkdirSync(to, { recursive: true });
  const files = walk(from).filter((f) => /\.enex$/i.test(f));
  for (const f of files) {
    let name = basename(f);
    for (let i = 2; existsSync(join(to, name)); i++) name = basename(f).replace(/\.enex$/i, ` ~${i}.enex`);
    copyFileSync(f, join(to, name));
  }
  return files.length;
}

function measure(exe, args, cwd, log, timeoutSec) {
  const out = execFileSync(
    "pwsh",
    [
      "-NoProfile",
      "-File",
      join(here, "measure.ps1"),
      "-Exe",
      exe,
      "-WorkDir",
      cwd,
      "-Log",
      log,
      "-TimeoutSec",
      String(timeoutSec),
      "-ArgsB64",
      Buffer.from(JSON.stringify(args)).toString("base64"),
    ],
    { encoding: "utf8", maxBuffer: 1 << 26 },
  );
  return JSON.parse(out.trim().split("\n").pop());
}

function yarleConfig(input, out, obsidian) {
  return {
    enexSources: [input],
    templateFile: join(yarleDir, "sampleTemplate.tmpl"),
    outputDir: out,
    isMetadataNeeded: true,
    skipWebClips: false,
    // Yarle's default. With true, 6.17.0 left every link pointing to Evernote in our runs, matched or not.
    keepEvernoteLinkIfNoNoteFound: false,
    encryptionPasswords: [PASSWORD],
    outputFormat: obsidian ? "ObsidianMD" : "StandardMD",
    taskOutputFormat: obsidian ? "ObsidianMD" : "StandardMD",
    imageSizeFormat: obsidian ? "ObsidianMD" : "StandardMD",
    useHashTags: true,
    pathSeparator: "/",
    dateFormat: "YYYY-MM-DD",
    nestedTags: { separatorInEN: "_", replaceSeparatorWith: "---", replaceSpaceWith: "-" },
    replacementChar: "_",
    replacementCharacterMap: {
      "<": "_",
      ">": "_",
      ":": "_",
      '"': "_",
      "/": "_",
      "\\": "_",
      "|": "_",
      "?": "_",
      "*": "_",
    },
    globalReplacementSettings: [],
    obsidianSettings: { omitLinkDisplayName: false },
    logseqSettings: { journalNotes: false },
  };
}

const RUNS = [
  {
    tool: "enex-to-markdown",
    mode: "Markdown",
    cmd: (i, o) => [process.execPath, [cli, i, "-o", o, "-q", "--password", PASSWORD]],
  },
  {
    tool: "enex-to-markdown",
    mode: "Obsidian",
    cmd: (i, o) => [process.execPath, [cli, i, "-o", o, "-q", "--obsidian", "--password", PASSWORD]],
  },
  { tool: "Yarle", mode: "Markdown", yarle: false },
  { tool: "Yarle", mode: "Obsidian", yarle: true },
  { tool: "evernote2md", mode: "Markdown", cmd: (i, o) => [e2md, [i, o, "--addFrontMatter"]] },
];

const sets = values.sets.split(",");
let results = [];
mkdirSync(work, { recursive: true });

// --rescore: score the outputs a previous run kept again (after a change to score.mjs), keeping its times.
if (values.rescore) {
  results = JSON.parse(readFileSync(join(work, "results.json"), "utf8"));
  for (const r of results) {
    const out = join(work, r.set, `${r.tool}-${r.mode}`, "out");
    const input = join(work, `${r.set}-flat`);
    if (!existsSync(out) || !existsSync(input)) continue;
    const expected =
      r.set === "stress"
        ? JSON.parse(readFileSync(join(resolve(values.inputs), "stress-expected.json"), "utf8"))
        : null;
    Object.assign(
      r,
      score(
        out,
        walk(input).filter((f) => /\.enex$/i.test(f)),
        expected,
      ),
    );
  }
}

for (const set of values.rescore ? [] : sets) {
  let input;
  if (set === "corpus") {
    if (!values.corpus) continue;
    input = join(work, "corpus-flat");
    console.log(`corpus: ${flatCopy(resolve(values.corpus), input)} files`);
  } else if (set === "stress") {
    input = join(work, "stress-flat");
    flatCopy(join(resolve(values.inputs), "stress"), input);
  } else input = join(resolve(values.inputs), set);
  if (!existsSync(input)) continue;
  const enexFiles = walk(input).filter((f) => /\.enex$/i.test(f));
  const expected =
    set === "stress" ? JSON.parse(readFileSync(join(resolve(values.inputs), "stress-expected.json"), "utf8")) : null;
  for (const run of RUNS) {
    const dir = join(work, set, `${run.tool}-${run.mode}`);
    rmSync(dir, { recursive: true, force: true });
    const out = join(dir, "out");
    mkdirSync(dir, { recursive: true });
    let exe;
    let args;
    if (run.cmd) [exe, args] = run.cmd(input, out);
    else {
      const config = join(dir, "config.json");
      writeFileSync(config, JSON.stringify(yarleConfig(input, out, run.yarle), null, 2));
      [exe, args] = [process.execPath, ["--max-old-space-size=4096", yarleCli, "--configFile", config]];
    }
    process.stdout.write(`${set} / ${run.tool} ${run.mode} ... `);
    const m = measure(exe, args, dir, join(dir, "log.txt"), set === "huge" || set === "big" ? 3600 : 900);
    const s = existsSync(out) ? score(out, set === "big" || set === "huge" ? [] : enexFiles, expected) : null;
    console.log(JSON.stringify({ ...m, notes: s?.notes, attachments: s?.attachments }));
    results.push({ set, tool: run.tool, mode: run.mode, ...m, ...s });
    if (!values.keep && (set === "big" || set === "huge")) rmSync(out, { recursive: true, force: true });
  }
}
writeFileSync(join(work, "results.json"), `${JSON.stringify(results, null, 2)}\n`);

const row = (r) =>
  `| ${r.set} | ${r.tool} ${r.mode} | ${r.timedOut ? "timed out" : r.exitCode === 0 ? "ok" : `exit ${r.exitCode}`} | ${r.notes ?? "-"} | ${r.attachments ?? "-"} | ${r.linksToNotes ?? "-"} / ${r.linksBroken ?? "-"} / ${r.linksToEvernote ?? "-"} | ${r.words ? `${r.wordsLost} of ${r.words}` : "-"} | ${r.seconds} s | ${r.peakMB} MB |`;
console.log(
  "\n| Set | Tool | Result | Notes | Attachments | Links: to a note / to no file / to Evernote | Words lost | Time | Peak memory |",
);
console.log("|---|---|---|---|---|---|---|---|---|");
for (const r of results) console.log(row(r));
console.log(`\nFull results: ${join(work, "results.json")}`);
