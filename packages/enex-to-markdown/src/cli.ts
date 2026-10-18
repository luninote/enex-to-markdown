import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { parseArgs } from "node:util";
import { convertEnex, type RunSummary, UsageError } from "./convert.ts";
import { FRONT_MATTER_MODES, type FrontMatterMode } from "./note.ts";

declare const __VERSION__: string | undefined;
const VERSION = typeof __VERSION__ === "string" ? __VERSION__ : "dev";

const HELP = `enex-to-markdown ${VERSION}
Convert Evernote ENEX exports to Markdown files.

Usage:
  enex-to-markdown <file.enex | folder> [more files or folders] [options]

Each .enex file becomes a folder (the notebook) with one .md file per note.
Attachments go in a _resources folder next to the notes. Anything that didn't
convert cleanly is listed in conversion-warnings.txt.

Options:
  -o, --out <folder>        Where to write (default: ./markdown-export)
      --obsidian            Write for Obsidian: [[links]], ![[embeds]], ==highlights==,
                            Tasks plugin dates, tags and aliases Obsidian accepts
      --dry-run             Write only the warnings file, to see what wouldn't convert
      --password <text>     Decrypt encrypted text with this password (repeatable)
      --password-file <f>   Passwords to try, one per line
      --frontmatter <mode>  none, minimal, standard (default) or full
      --date-prefix         Start file names with the note's creation date
      --fuzzy-links         Also match links to the closest note title (each one is listed)
      --no-merge-parts      Keep "Work (1).enex", "Work (2).enex" in separate folders
      --overwrite           Write into an output folder that already has files
      --keep-clip-html      Keep heavily styled web clips as HTML instead of converting them
      --keep-colors         Keep text colors and fonts (as inline HTML)
  -q, --quiet               Print only the summary
  -h, --help                Show this help
  -v, --version             Show the version
`;

const PROMO =
  "Leaving Evernote? LuniNote imports your ENEX files directly, notebooks, tags and links included: https://luninote.com";

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function printSummary(s: RunSummary): void {
  const out = relative(process.cwd(), s.outDir) || ".";
  const lines = [
    "",
    s.dryRun
      ? `Dry run: read ${plural(s.notes, "note")} from ${plural(s.notebooks, "notebook")}; nothing was converted`
      : `Converted ${plural(s.notes, "note")} from ${plural(s.notebooks, "notebook")} into ${out}`,
    `  Attachments: ${s.attachments}`,
    `  Links between notes rewritten: ${s.linksRewritten}${s.linksInferred ? ` (${s.linksInferred} by a looser match, listed in the warnings file)` : ""}`,
  ];
  if (s.linksLeft) lines.push(`  Links still pointing to Evernote: ${s.linksLeft} (listed in the warnings file)`);
  if (s.tasks) lines.push(`  Tasks: ${s.tasks}`);
  if (s.decrypted) lines.push(`  Encrypted blocks decrypted: ${s.decrypted}`);
  if (s.notesFailed) lines.push(`  Notes kept as HTML or placeholder: ${s.notesFailed}`);
  if (s.filesFailed) lines.push(`  Files that couldn't be read: ${s.filesFailed}`);
  if (s.warningsFile)
    lines.push(
      `  Warnings: ${plural(s.withWarnings, "entry", "entries")}${s.withWarnings ? " to check" : ""}, in ${relative(process.cwd(), s.warningsFile)}`,
    );
  else lines.push("  Warnings: none");
  lines.push("", PROMO);
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function passwords(list: string[] | undefined, file: string | undefined): Promise<string[]> {
  const out = [...(list ?? [])];
  if (file) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      throw new UsageError(`Can't read the password file ${file}`);
    }
    out.push(...text.split(/\r?\n/).filter((l) => l.length > 0));
  }
  return out;
}

export async function main(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${HELP}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (!positionals.length) {
    process.stderr.write(HELP);
    return 2;
  }
  const mode = values.frontmatter ?? "standard";
  if (!FRONT_MATTER_MODES.includes(mode as FrontMatterMode)) {
    process.stderr.write(`--frontmatter takes ${FRONT_MATTER_MODES.join(", ")}\n`);
    return 2;
  }
  try {
    const summary = await convertEnex(positionals, {
      outDir: values.out ?? "markdown-export",
      overwrite: values.overwrite === true,
      keepClipHtml: values["keep-clip-html"] === true,
      keepColors: values["keep-colors"] === true,
      obsidian: values.obsidian === true,
      frontMatter: mode as FrontMatterMode,
      datePrefix: values["date-prefix"] === true,
      passwords: await passwords(values.password, values["password-file"]),
      fuzzyLinks: values["fuzzy-links"] === true,
      mergeParts: values["no-merge-parts"] !== true,
      dryRun: values["dry-run"] === true,
      onFile: (e) => {
        if (values.quiet || e.phase !== "convert") return;
        const name = relative(process.cwd(), e.file) || e.file;
        process.stderr.write(
          e.error ? `${name}: ${plural(e.notes, "note")}, then: ${e.error}\n` : `${name}: ${plural(e.notes, "note")}\n`,
        );
      },
    });
    printSummary(summary);
    return summary.filesFailed ? 1 : 0;
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\n`);
      return 2;
    }
    process.stderr.write(`Conversion stopped: ${(err as Error).stack ?? err}\n`);
    return 1;
  }
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: "string", short: "o" },
      obsidian: { type: "boolean" },
      "dry-run": { type: "boolean" },
      password: { type: "string", multiple: true },
      "password-file": { type: "string" },
      frontmatter: { type: "string" },
      "date-prefix": { type: "boolean" },
      "fuzzy-links": { type: "boolean" },
      "no-merge-parts": { type: "boolean" },
      overwrite: { type: "boolean" },
      "keep-clip-html": { type: "boolean" },
      "keep-colors": { type: "boolean" },
      quiet: { type: "boolean", short: "q" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
}
