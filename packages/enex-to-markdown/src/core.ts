import { type ConvertResource, convertEnml, type LinkResolution, noteHref, Warnings } from "@luninote/enml";
import { type EnexNote, type EnexResource, type EnexTask, type ResourceSink, readEnex } from "@luninote/enml/reader";
import {
  attachmentPath,
  type DocNode,
  docToMarkdown,
  hrefOf,
  type RenderContext,
  relativePath,
  safeName,
  UniqueNames,
} from "@luninote/export";
import { applyCodeLanguages, codeLanguages } from "./code.ts";
import { decryptEnml } from "./crypt.ts";
import { md5Hex } from "./hash.ts";
import { decodeEnex, type InputInfo } from "./input.ts";
import { evernoteLinks, LinkIndex, type LinkMatch, type LinkUse, type NoteRef } from "./links.ts";
import {
  type FrontMatterMode,
  fenced,
  frontMatter,
  markUnconverted,
  type NoteMeta,
  obsidianTag,
  titleHeading,
} from "./note.ts";
import { MAX_PATH, obsidianName, shortenTo, splitParts } from "./paths.ts";
import { Findings, type ReportEntry, reportable, reportText } from "./report.ts";
import { taskLine } from "./tasks.ts";

// The converter without a platform: ENEX bytes come in through `EnexSource`, files go out through `Output`. The command
// line (convert.ts) writes a folder; the browser build (browser/) writes a ZIP.

export const RESOURCES_DIR = "_resources";
export const WARNINGS_FILE = "conversion-warnings.txt";

/** Where an attachment's bytes wait while its note is read: its file name comes from fields after the data. */
export type Staged = ReturnType<ResourceSink>;

export interface EnexSource {
  /** File name, "Work (1).enex". */
  name: string;
  /** How messages and the warnings file name the file (a full path on the command line). */
  label: string;
  /** Folder of the file relative to the folder given ("Stack"), "" at the top. */
  relDir: string;
  size: number;
  /** The file's bytes from the start; read once per pass. */
  open(): AsyncIterable<Uint8Array>;
}

/** Paths are relative to the output folder, with "/" between folders. */
export interface Output {
  stage(key: string): Staged;
  commit(staged: Staged, path: string): Promise<void>;
  discard(staged: Staged): Promise<void>;
  dir(path: string): Promise<void>;
  /** `mtime` is set where the output can hold one. */
  write(path: string, data: string | Uint8Array, mtime: Date | null): Promise<void>;
}

export interface RunOptions {
  /** Length of the full path of the output folder, which counts towards `maxPath`. */
  rootLength: number;
  /** Keep heavily styled web clips as HTML inside the Markdown instead of converting them. */
  keepClipHtml?: boolean;
  /** Keep text colors and fonts as inline HTML. Off by default: in Markdown apps they're noise, and white text vanishes. */
  keepColors?: boolean;
  /** Obsidian flavor: [[wikilinks]], ![[embeds]], ==highlights==, Tasks plugin fields, tags and aliases it accepts. */
  obsidian?: boolean;
  frontMatter?: FrontMatterMode;
  /** Start file names with the note's creation date ("2024-01-31 Title.md"). */
  datePrefix?: boolean;
  /** Passwords to try on encrypted text. */
  passwords?: readonly string[];
  /** Match links whose text is close to one title (each one is reported). */
  fuzzyLinks?: boolean;
  /** Put "Work.enex", "Work (1).enex"… in one "Work" folder (default true). */
  mergeParts?: boolean;
  /** Convert without writing anything but the warnings file. */
  dryRun?: boolean;
  /** Longest full path to write (default 250). */
  maxPath?: number;
  /** Replaces the warnings file's description of a finding, by code. */
  wording?: Readonly<Record<string, string>>;
  onFile?: (event: FileEvent) => void;
  onProgress?: (progress: Progress) => void;
  signal?: AbortSignal;
  /** Replaces the Markdown writer (tests use it to make one note fail). */
  render?: (doc: DocNode, ctx: RenderContext, note: EnexNote) => string;
}

export interface FileEvent {
  file: string;
  phase: "scan" | "convert";
  notes: number;
  error: string | null;
}

export interface Progress {
  phase: "scan" | "convert";
  file: string;
  /** Notes read so far in this pass, all files. */
  notes: number;
  /** Bytes read so far; every file is read twice, so the total is twice the input. */
  bytes: number;
  totalBytes: number;
}

export interface RunSummary {
  outDir: string;
  dryRun: boolean;
  files: number;
  filesFailed: number;
  notebooks: number;
  notes: number;
  notesFailed: number;
  attachments: number;
  linksRewritten: number;
  /** Links rewritten by a tier after exact title (listed in the warnings file). */
  linksInferred: number;
  /** Links left pointing to Evernote (listed in the warnings file). */
  linksLeft: number;
  decrypted: number;
  tasks: number;
  /** Notes (and files) with something listed in the warnings file. */
  withWarnings: number;
  warningsFile: string | null;
}

interface PlannedNote extends NoteRef {
  /** Folder of the note's attachments, relative to the output folder. */
  resDir: string;
  links: LinkUse[];
  shortened: string[];
}

interface InputFile {
  index: number;
  source: EnexSource;
  /** Output folder of the notebook ("Stack/Notebook"); parts of a split export share it. */
  folder: string;
  /** Input folder relative to the folder given ("Stack"). */
  stack: string;
  noteNames: UniqueNames;
  resNames: UniqueNames;
  plan: Map<number, PlannedNote>;
  error: string | null;
  input: InputInfo | null;
}

export function convertSources(
  sources: readonly EnexSource[],
  output: Output,
  options: RunOptions,
): Promise<RunSummary> {
  return new Run(output, options).run(sources);
}

const LINK_FINDING: Record<string, { code: string; severity: "warning" | "info" }> = {
  notebook: { code: "link_notebook", severity: "info" },
  stack: { code: "link_stack", severity: "info" },
  "other-link": { code: "link_other_link", severity: "info" },
  loose: { code: "link_loose", severity: "info" },
  fuzzy: { code: "link_fuzzy", severity: "warning" },
  ambiguous: { code: "link_ambiguous", severity: "warning" },
  missing: { code: "link_missing", severity: "warning" },
  attachment: { code: "link_attachment", severity: "warning" },
};

// The shared ENEX reader takes Node Buffers; the browser build supplies a Buffer for it (browser/shims/buffer.ts).
declare const Buffer: { from(data: ArrayBufferLike, offset: number, length: number): Uint8Array };

function readerInput(chunks: AsyncGenerator<Uint8Array>): Parameters<typeof readEnex>[0] {
  async function* buffers() {
    for await (const c of chunks) yield Buffer.from(c.buffer, c.byteOffset, c.byteLength);
  }
  const it = buffers();
  return {
    [Symbol.asyncIterator]: () => it,
    destroy: () => {
      void it.return(undefined);
    },
  } as unknown as Parameters<typeof readEnex>[0];
}

const noteId = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

class Run {
  private readonly out: Output;
  private readonly opts: RunOptions;
  private readonly obsidian: boolean;
  private readonly maxPath: number;
  private readonly notes = new Map<string, PlannedNote>();
  private readonly report: ReportEntry[] = [];
  private readonly renamedTags = new Map<string, string>();
  private links = new LinkIndex([]);
  private wikiTargets = new Map<string, string>();
  private readonly summary: RunSummary;
  private ids = 0;
  private bytes = 0;
  private totalBytes = 0;
  private notesRead = 0;

  constructor(out: Output, opts: RunOptions) {
    this.out = out;
    this.opts = opts;
    this.obsidian = opts.obsidian === true;
    this.maxPath = opts.maxPath ?? MAX_PATH;
    this.summary = {
      outDir: "",
      dryRun: opts.dryRun === true,
      files: 0,
      filesFailed: 0,
      notebooks: 0,
      notes: 0,
      notesFailed: 0,
      attachments: 0,
      linksRewritten: 0,
      linksInferred: 0,
      linksLeft: 0,
      decrypted: 0,
      tasks: 0,
      withWarnings: 0,
      warningsFile: null,
    };
  }

  private get dry(): boolean {
    return this.opts.dryRun === true;
  }

  /** Rethrows when the run was cancelled; every place that turns an error into a warning calls it first. */
  private stopIfCancelled(): void {
    this.opts.signal?.throwIfAborted();
  }

  async run(sources: readonly EnexSource[]): Promise<RunSummary> {
    const files = this.planFolders(sources);
    this.summary.files = files.length;
    this.totalBytes = 2 * sources.reduce((n, s) => n + s.size, 0);
    // First pass: every note's file name, title and links, so a link can point at a note converted later.
    for (const f of files) await this.scan(f);
    this.links = new LinkIndex(this.notes.values(), { fuzzy: this.opts.fuzzyLinks === true });
    this.links.learn(
      (function* (notes: Iterable<PlannedNote>) {
        for (const n of notes) for (const use of n.links) yield { use, from: n };
      })(this.notes.values()),
    );
    if (this.obsidian) this.wikiTargets = wikiTargets(this.notes.values());
    this.notesRead = 0;
    for (const f of files) {
      if (f.error) {
        this.bytes += f.source.size;
        continue;
      }
      await this.convertFile(f);
    }
    for (const f of files) if (f.error) this.summary.filesFailed++;
    this.summary.notebooks = new Set(files.filter((f) => !f.error).map((f) => f.folder)).size;
    if (this.renamedTags.size)
      this.report.push({
        where: "(all notes)",
        source: "tags",
        warnings: [
          {
            code: "tags_renamed",
            severity: "info",
            count: this.renamedTags.size,
            details: [...this.renamedTags].map(([from, to]) => `"${from}" is now #${to}`),
          },
        ],
      });
    this.summary.withWarnings = this.report.length;
    if (this.report.length || this.dry) {
      const n = this.report.length;
      const header = this.dry
        ? `Dry run: nothing was converted. A real run would list these (${n} ${n === 1 ? "entry" : "entries"}).`
        : `Things that didn't convert cleanly, by file (${n} ${n === 1 ? "file" : "files"}).`;
      await this.out.write(WARNINGS_FILE, reportText(this.report, header, this.opts.wording), null);
      this.summary.warningsFile = WARNINGS_FILE;
    }
    return this.summary;
  }

  /** The file's bytes, counted for progress; a file read only partly still counts in full once it's done. */
  private read(f: InputFile): AsyncIterable<Uint8Array> {
    const self = this;
    return (async function* () {
      let read = 0;
      try {
        for await (const chunk of f.source.open()) {
          read += chunk.length;
          self.bytes += chunk.length;
          yield chunk;
        }
      } finally {
        self.bytes += Math.max(0, f.source.size - read);
      }
    })();
  }

  private progress(phase: Progress["phase"], f: InputFile): void {
    this.opts.onProgress?.({
      phase,
      file: f.source.label,
      notes: this.notesRead,
      bytes: Math.min(this.bytes, this.totalBytes),
      totalBytes: this.totalBytes,
    });
  }

  /** One folder per notebook, named after its file; folders of the input are kept (an exported stack stays together). */
  private planFolders(sources: readonly EnexSource[]): InputFile[] {
    const clean = (name: string) => (this.obsidian ? obsidianName(name) : name);
    const namers = new Map<string, UniqueNames>();
    const namer = (dir: string) => {
      let n = namers.get(dir.toLowerCase());
      if (!n) {
        n = new UniqueNames();
        namers.set(dir.toLowerCase(), n);
      }
      return n;
    };
    const dirs = new Map<string, string>();
    const outDir = (rel: string): string => {
      if (!rel) return "";
      const known = dirs.get(rel);
      if (known !== undefined) return known;
      const cut = rel.lastIndexOf("/");
      const parent = outDir(cut < 0 ? "" : rel.slice(0, cut));
      const name = namer(parent).take(clean(rel.slice(cut + 1)));
      const out = parent ? `${parent}/${name}` : name;
      dirs.set(rel, out);
      return out;
    };
    for (const s of sources) outDir(s.relDir);
    const parts = this.opts.mergeParts === false ? new Map<EnexSource, string>() : splitParts(sources);
    const books = new Map<string, { folder: string; noteNames: UniqueNames; resNames: UniqueNames }>();
    return sources.map((s, index) => {
      const parent = outDir(s.relDir);
      const part = parts.get(s);
      const key = part === undefined ? null : `${s.relDir}\u0000${part.toLowerCase()}`;
      let book = key ? books.get(key) : undefined;
      if (!book) {
        const name = namer(parent).take(clean(part ?? s.name.replace(/\.enex$/i, "")));
        book = {
          folder: parent ? `${parent}/${name}` : name,
          noteNames: new UniqueNames(),
          resNames: new UniqueNames(),
        };
        if (key) books.set(key, book);
      }
      return { index, source: s, stack: s.relDir, ...book, plan: new Map(), error: null, input: null };
    });
  }

  private async scan(f: InputFile): Promise<void> {
    const reader = readEnex(readerInput(decodeEnex(this.read(f)).chunks));
    try {
      for await (const n of reader.notes) {
        this.stopIfCancelled();
        const planned = this.planNote(f, n);
        f.plan.set(n.ordinal, planned);
        this.notes.set(planned.id, planned);
        await this.discard(n.resources);
        this.notesRead++;
        this.progress("scan", f);
      }
      if (!reader.info.exportRoot && !f.plan.size) f.error = "This file isn't an Evernote export (ENEX).";
    } catch (err) {
      this.stopIfCancelled();
      // Notes read before the damage are still converted; the second pass meets the same error and reports it.
      if (!f.plan.size) f.error = (err as Error).message;
    }
    this.opts.onFile?.({ file: f.source.label, phase: "scan", notes: f.plan.size, error: f.error });
    if (f.error) this.report.push({ where: f.source.name, source: f.source.label, warnings: [fileWarning(f.error)] });
  }

  /** The note's file and attachment folder, shortened when the full path would be too long. */
  private planNote(f: InputFile, n: EnexNote): PlannedNote {
    const id = noteId(++this.ids);
    const title = n.title || "Untitled";
    let base = this.obsidian ? obsidianName(title) : title;
    if (this.opts.datePrefix && n.created) base = `${n.created.toISOString().slice(0, 10)} ${base}`;
    const shortened: string[] = [];
    const room = this.maxPath - (this.opts.rootLength + 1 + f.folder.length + 1) - ".md".length - " (99)".length;
    const safe = safeName(base);
    if (safe.length > room) {
      base = shortenTo(base, Math.max(12, room));
      shortened.push(`${safe}.md -> ${base}.md`);
    }
    const name = f.noteNames.take(base, ".md");
    const stem = name.slice(0, -".md".length);
    // Room for an attachment name of 40 characters in the note's attachment folder.
    const resRoot = `${f.folder}/${RESOURCES_DIR}`;
    const resRoom = this.maxPath - (this.opts.rootLength + 1 + resRoot.length + 1) - 1 - 40 - " (99)".length;
    let resName = stem;
    if (stem.length > resRoom) {
      resName = shortenTo(stem, Math.max(12, resRoom));
      shortened.push(`${RESOURCES_DIR}/${stem} -> ${RESOURCES_DIR}/${resName}`);
    }
    const resDir = `${resRoot}/${f.resNames.take(resName)}`;
    return {
      id,
      title: n.title || "Untitled",
      guid: n.guid,
      notebook: f.folder,
      stack: f.stack,
      path: `${f.folder}/${name}`,
      resDir,
      links: evernoteLinks(n.content),
      shortened,
    };
  }

  private async convertFile(f: InputFile): Promise<void> {
    if (!this.dry) await this.out.dir(f.folder);
    let converted = 0;
    let error: string | null = null;
    const decoded = decodeEnex(this.read(f));
    f.input = decoded.info;
    const reader = readEnex(
      readerInput(decoded.chunks),
      this.dry ? {} : { sink: (meta) => this.out.stage(`${f.index}-${meta.ordinal}-${meta.index}-${meta.kind}`) },
    );
    try {
      for await (const note of reader.notes) {
        this.stopIfCancelled();
        await this.convertNote(f, note);
        converted++;
        this.notesRead++;
        this.progress("convert", f);
      }
    } catch (err) {
      this.stopIfCancelled();
      error = (err as Error).message;
    }
    const fileWarnings = new Warnings();
    fileWarnings.merge(reader.info.warnings);
    if (decoded.info.encoding !== "utf-8") fileWarnings.add("input_recoded", decoded.info.encoding);
    if (decoded.info.repaired) fileWarnings.add("input_repaired", `${decoded.info.repaired} bytes`);
    if (reader.info.truncated)
      fileWarnings.add("file_truncated", `note ${reader.info.truncated.ordinal + 1}: ${reader.info.truncated.title}`);
    if (error) {
      fileWarnings.add("file_unreadable", error);
      f.error = error;
    }
    const listed = reportable(
      fileWarnings.list().map((w) => (w.code === "input_recoded" ? { ...w, severity: "info" as const } : w)),
    );
    if (listed.length) this.report.push({ where: f.folder, source: f.source.label, warnings: listed });
    this.opts.onFile?.({ file: f.source.label, phase: "convert", notes: converted, error });
  }

  private async convertNote(f: InputFile, note: EnexNote): Promise<void> {
    const planned = f.plan.get(note.ordinal) ?? this.unplanned(f, note);
    const mdPath = planned.path;
    const resDir = planned.resDir;
    const warnings = new Warnings();
    warnings.merge(note.warnings);
    const findings = new Findings();
    for (const s of planned.shortened) findings.add("path_shortened", "info", s);
    const title = note.title || "Untitled";
    const head = this.head(note, mdPath, title);
    this.summary.notes++;

    if (note.encryptedExport) {
      await this.discard(note.resources);
      warnings.add("password_export", null);
      const body =
        "*This note was exported with a password, so its content couldn't be read. Export the notebook again without a password and convert it again.*\n";
      await this.writeNote(mdPath, head + body, note);
      this.summary.notesFailed++;
      this.record(mdPath, f, note, warnings, findings);
      return;
    }

    let made = false;
    const ensureDir = async () => {
      if (!made && !this.dry) await this.out.dir(resDir);
      made = true;
    };
    // convertEnml hands over inline images synchronously; they're written once it returns.
    const images: { name: string; bytes: Uint8Array }[] = [];
    const writeImages = async () => {
      for (const img of images.splice(0)) {
        await ensureDir();
        if (!this.dry) await this.out.write(`${resDir}/${img.name}`, img.bytes, null);
      }
    };
    try {
      const names = new UniqueNames();
      const files = new Map<string, { path: string; mime: string; filename: string | null }>();
      const resources: ConvertResource[] = [];
      const room = this.maxPath - (this.opts.rootLength + 1 + resDir.length + 1);
      for (const r of note.resources) {
        const id = `r${r.index}`;
        const mime = r.mime ?? "application/octet-stream";
        const original = r.attributes["file-name"]?.trim() || null;
        const name = this.fileName(names, original, mime, r.index, room, findings);
        resources.push({ md5: r.digest.md5, resourceId: id, mime, filename: original ?? name });
        if (!r.hasData || (!r.sink && !this.dry)) {
          await this.discardOne(r.sink);
          await this.discardOne(r.alternateSink);
          continue;
        }
        await ensureDir();
        if (r.sink) await this.out.commit(r.sink, `${resDir}/${name}`);
        files.set(id, { path: `${resDir}/${name}`, mime, filename: original ?? name });
        this.summary.attachments++;
        if (r.alternateSink || (this.dry && r.alternate)) {
          const alt = names.take(`${name.replace(/\.[^.]*$/, "")}-alternate`, ".bin");
          if (r.alternateSink) await this.out.commit(r.alternateSink, `${resDir}/${alt}`);
          warnings.add("alternate_data", `${RESOURCES_DIR}/${resDir.slice(resDir.lastIndexOf("/") + 1)}/${alt}`);
        }
      }

      let content = note.content;
      if (this.opts.passwords?.length) {
        const d = await decryptEnml(content, this.opts.passwords);
        content = d.enml;
        this.summary.decrypted += d.decrypted;
        if (d.decrypted) findings.add("decrypted", "info", `${d.decrypted} block(s)`);
        for (const hint of d.failed) findings.add("decrypt_failed", "warning", hint ? `hint: ${hint}` : "no hint");
      }

      // Tasks get ids unique within the note, so each written task finds its own fields again.
      const taskById = new Map<string, EnexTask>();
      const tasks = note.tasks.map((t, i) => {
        const id = `t${i + 1}`;
        taskById.set(id, t);
        return { ...t, id };
      });

      let inline = 0;
      const result = convertEnml(content, {
        resources,
        tasks,
        resolveLink: (href, text) => this.resolveLink(href, text, planned, findings),
        ...(this.opts.keepClipHtml ? { sanitizeHtml: (html: string) => html } : {}),
        storeDataImage: (mime, bytes) => {
          const n = ++inline;
          const ext = extensionFor(mime);
          const name = names.take(`image-${n}`, ext === "bin" ? "" : `.${ext}`);
          images.push({ name, bytes });
          const id = `d${n}`;
          files.set(id, { path: `${resDir}/${name}`, mime, filename: name });
          this.summary.attachments++;
          return { md5: md5Hex(bytes), resourceId: id, mime, filename: name };
        },
      });
      await writeImages();
      warnings.merge(
        this.opts.passwords?.length ? result.warnings.filter((w) => w.code !== "encrypted") : result.warnings,
      );
      if (warnings.has("conversion_failed")) {
        // The converter's own fallback keeps only the text; the original markup says more.
        await this.writeNote(mdPath, head + failedBody(note.content), note);
        this.summary.notesFailed++;
        this.record(mdPath, f, note, warnings, findings);
        return;
      }
      this.summary.tasks += result.stats.tasks;
      const doc = markUnconverted(result.doc as DocNode);
      applyCodeLanguages(doc, codeLanguages(content));
      const ctx = this.renderContext(mdPath, files, taskById, findings);
      const body = this.opts.render ? this.opts.render(doc, ctx, note) : docToMarkdown(doc, ctx);
      await this.writeNote(mdPath, head + body, note);
    } catch (err) {
      this.stopIfCancelled();
      await writeImages();
      warnings.add("conversion_failed", (err as Error).message);
      this.summary.notesFailed++;
      await this.writeNote(mdPath, head + failedBody(note.content), note);
    }
    this.record(mdPath, f, note, warnings, findings);
  }

  private head(note: EnexNote, mdPath: string, title: string): string {
    const mode = this.opts.frontMatter ?? "standard";
    let tags: readonly string[] = note.tags;
    const stem = mdPath.slice(mdPath.lastIndexOf("/") + 1, -".md".length);
    const aliases: string[] = [];
    if (this.obsidian) {
      tags = note.tags.map((t) => {
        const tag = obsidianTag(t);
        if (tag !== t) this.renamedTags.set(t, tag);
        return tag;
      });
      if (stem !== title) aliases.push(title);
    }
    const meta: NoteMeta = {
      title,
      created: note.created,
      updated: note.updated,
      tags,
      attributes: note.attributes,
      ...(aliases.length ? { aliases } : {}),
    };
    // Obsidian shows the file name as the title; the heading would repeat it.
    const heading = this.obsidian && mode !== "none" ? "" : `${titleHeading(title)}\n\n`;
    return frontMatter(meta, mode) + heading;
  }

  private resolveLink(href: string, text: string, from: PlannedNote, findings: Findings): LinkResolution | null {
    const m: LinkMatch | null = this.links.match(href, text, from);
    if (!m) return null;
    const shown = `"${text.replace(/\s+/g, " ").trim().slice(0, 120)}"`;
    if (m.ok) {
      this.summary.linksRewritten++;
      const finding = LINK_FINDING[m.how];
      if (finding) {
        this.summary.linksInferred++;
        findings.add(finding.code, finding.severity, `${shown} -> ${m.note.path}`);
      }
      return {
        kind: "resolved",
        href: noteHref(m.note.id),
        noteId: m.note.id,
        by: m.how === "guid" ? "guid" : "title",
      };
    }
    this.summary.linksLeft++;
    const finding = LINK_FINDING[m.why] as { code: string; severity: "warning" | "info" };
    const more = m.candidates.length > 5 ? `, and ${m.candidates.length - 5} more` : "";
    const candidates = m.candidates.length
      ? `: ${m.candidates
          .slice(0, 5)
          .map((c) => c.path)
          .join(", ")}${more}`
      : "";
    findings.add(finding.code, finding.severity, `${shown}${candidates}`);
    return { kind: "unresolved", reason: m.why };
  }

  private renderContext(
    mdPath: string,
    files: Map<string, { path: string; mime: string; filename: string | null }>,
    taskById: Map<string, EnexTask>,
    findings: Findings,
  ): RenderContext {
    const style = this.obsidian ? "obsidian" : "plain";
    const ctx: RenderContext = {
      attachment: (id) => {
        const a = files.get(id);
        return a ? { href: hrefOf(relativePath(mdPath, a.path)), mime: a.mime, filename: a.filename } : null;
      },
      noteLink: (id) => {
        const target = this.notes.get(id);
        return target ? hrefOf(relativePath(mdPath, target.path)) : null;
      },
      textStyles: this.opts.keepColors === true,
      taskSuffix: (item) => {
        const id = typeof item.attrs?.taskId === "string" ? item.attrs.taskId : null;
        const task = id ? taskById.get(id) : undefined;
        if (!task) return "";
        const line = taskLine(task, style);
        for (const d of line.dropped) findings.add("task_detail_dropped", "warning", d);
        return line.suffix;
      },
    };
    if (this.obsidian) {
      ctx.highlight = "equals";
      ctx.escapeExtra = true;
      ctx.wikiLinks = {
        note: (id) => this.wikiTargets.get(id) ?? null,
        attachment: (id) => files.get(id)?.path ?? null,
      };
    }
    return ctx;
  }

  /** The attachment's own file name, made unique within its note; a generated one when the export has none. */
  private fileName(
    names: UniqueNames,
    original: string | null,
    mime: string,
    index: number,
    room: number,
    findings: Findings,
  ): string {
    const ext = extensionFor(mime);
    let base: string;
    let suffix: string;
    if (original) {
      const own = extname(original);
      if (EXT.test(own) && original.length > own.length) [base, suffix] = [original.slice(0, -own.length), own];
      else [base, suffix] = [original, ext === "bin" ? "" : `.${ext}`];
    } else {
      const kind = /^(image|audio|video)\//.exec(mime)?.[1] ?? "attachment";
      [base, suffix] = [`${kind}-${index + 1}`, ext === "bin" ? "" : `.${ext}`];
    }
    if (this.obsidian) base = obsidianName(base);
    const safe = safeName(base);
    const fits = room - suffix.length - " (99)".length;
    if (safe.length > fits) {
      base = shortenTo(base, Math.max(8, fits));
      findings.add("path_shortened", "info", `${safe}${suffix} -> ${base}${suffix}`);
    }
    return names.take(base, suffix);
  }

  private unplanned(f: InputFile, note: EnexNote): PlannedNote {
    const planned = this.planNote(f, note);
    this.notes.set(planned.id, planned);
    if (this.obsidian) this.wikiTargets.set(planned.id, planned.path.replace(/\.md$/, ""));
    return planned;
  }

  private async writeNote(mdPath: string, text: string, note: EnexNote): Promise<void> {
    if (this.dry) return;
    await this.out.write(mdPath, text, note.updated ?? note.created);
  }

  private async discardOne(staged: Staged | null): Promise<void> {
    if (staged) await this.out.discard(staged);
  }

  private async discard(resources: readonly EnexResource[]): Promise<void> {
    for (const r of resources) {
      await this.discardOne(r.sink);
      await this.discardOne(r.alternateSink);
    }
  }

  private record(mdPath: string, f: InputFile, note: EnexNote, warnings: Warnings, findings: Findings): void {
    const listed = reportable([...warnings.list(), ...findings.list()]);
    if (!listed.length) return;
    this.report.push({
      where: mdPath,
      source: `${f.source.name}, note ${note.ordinal + 1}${note.title ? ` "${note.title}"` : ""}`,
      warnings: listed,
    });
  }
}

/** What goes between [[ ]] for each note: its name when no other note has it, else its path without ".md". */
function wikiTargets(notes: Iterable<PlannedNote>): Map<string, string> {
  const list = [...notes];
  const count = new Map<string, number>();
  const stem = (n: PlannedNote) => n.path.slice(n.path.lastIndexOf("/") + 1, -".md".length);
  for (const n of list) count.set(stem(n).toLowerCase(), (count.get(stem(n).toLowerCase()) ?? 0) + 1);
  return new Map(
    list.map((n) => [n.id, count.get(stem(n).toLowerCase()) === 1 ? stem(n) : n.path.slice(0, -".md".length)]),
  );
}

function failedBody(enml: string): string {
  return `*This note couldn't be converted to Markdown. Its original content follows as HTML.*\n\n${fenced(enml, "html")}\n`;
}

function fileWarning(message: string) {
  return { code: "file_skipped", severity: "warning" as const, count: 1, details: [message] };
}

/** The extension the MIME type implies ("png"), or "bin" when it's unknown. */
function extensionFor(mime: string): string {
  return attachmentPath("x", mime).slice("attachments/x.".length);
}

/** Node's path.extname for a file name: the last dot, unless the name starts with it. */
function extname(name: string): string {
  const base = name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 || /^\.+$/.test(base) ? "" : base.slice(dot);
}

const EXT = /^\.[A-Za-z0-9]{1,10}$/;
