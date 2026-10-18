import { createHash, type Hash } from "node:crypto";
import { once } from "node:events";
import type { Readable, Writable } from "node:stream";
import { finished } from "node:stream/promises";
import sax from "sax";
import { parseEnexDate } from "../dates.ts";
import { parseRecoIndex } from "../recoindex.ts";
import { type NoteWarning, Warnings } from "../warnings.ts";
import { Base64StreamDecoder } from "./base64.ts";

// Streaming ENEX reader (evernote-export3/4 DTD). One note at a time, flat memory: resource bytes are
// decoded and hashed as they arrive and written straight to a sink; nothing holds a whole attachment.

export const ENML_MAX_CHARS = 5_242_880;
export const RESOURCE_MAX_BYTES = 25 * 1024 * 1024;

const CAPTURE_LIMIT = 1 << 20;
const CONTENT_LIMIT = 64 << 20;
const RECOGNITION_LIMIT = 32 << 20;
const MAX_XML_ERRORS = 10_000;
// Written before a stream that starts mid-file (resume at a note boundary) so the parser has a root.
const RESUME_PREFIX = "<en-export>";
const NOTE_LEVEL = new Set([
  "title",
  "content",
  "created",
  "updated",
  "tag",
  "resource",
  "task",
  "guid",
  "note-attributes",
  "note-custom-metadata",
]);
const REPAIRABLE = new Set(["note-attributes", "resource-attributes", "resource", "note-custom-metadata"]);

export interface SinkMeta {
  ordinal: number;
  index: number;
  kind: "data" | "alternate";
}

export type ResourceSink = (meta: SinkMeta) => Writable;

export interface BinaryDigest {
  md5: string;
  sha256: string;
  size: number;
}

export interface EnexRecognition {
  xml: string;
  text: string;
  items: number;
  lang: string | null;
  docType: string | null;
  objType: string | null;
}

export interface EnexResource {
  index: number;
  /** False when the resource had no `<data>` element at all; its digest is then that of zero bytes. */
  hasData: boolean;
  digest: BinaryDigest;
  mime: string | null;
  width: number | null;
  height: number | null;
  duration: number | null;
  attributes: Record<string, string>;
  applicationData: Record<string, string>;
  recognition: EnexRecognition | null;
  alternate: BinaryDigest | null;
  /** The streams the bytes were written to (as returned by the sink), so the caller can find its handles. */
  sink: Writable | null;
  alternateSink: Writable | null;
}

export interface EnexTask {
  /** `noteLevelID`: the task's id, unique within its note. */
  id: string | null;
  title: string;
  status: string | null;
  flag: boolean;
  sortWeight: string | null;
  groupId: string | null;
  dueDate: Date | null;
  /** Every child element as text, verbatim (title, created, dueDate, timeZone, recurrence, …). */
  fields: Record<string, string>;
  reminders: Record<string, string>[];
}

export interface EnexNote {
  ordinal: number;
  title: string;
  content: string;
  created: Date | null;
  updated: Date | null;
  createdRaw: string | null;
  updatedRaw: string | null;
  tags: string[];
  attributes: Record<string, string>;
  applicationData: Record<string, string>;
  tasks: EnexTask[];
  resources: EnexResource[];
  /** From `<guid>` or `<note-custom-metadata><guid>` (evernote-backup `--add-guid` / `--add-metadata`). */
  guid: string | null;
  customMetadata: Record<string, string>;
  /** Unknown direct children of `<note>`, as text. */
  extra: Record<string, string>;
  /** Content or data marked `encoding="base64:aes"`: a password-protected export we can't read. */
  encryptedExport: boolean;
  warnings: NoteWarning[];
  /** Byte offset just after `</note>` in the file, or null when it can't be known exactly. */
  byteEnd: number | null;
}

/** The file isn't one an import can use (not XML at all, or not an Evernote export). Retrying won't help. */
export class EnexFormatError extends Error {}

export interface EnexFileInfo {
  exportRoot: boolean;
  application: string | null;
  version: string | null;
  exportDate: string | null;
  /** Every `<note>` start tag seen, including skipped and truncated ones. */
  notesSeen: number;
  /** A note the file ends inside of (a cut-off export). */
  truncated: { ordinal: number; title: string } | null;
  /**
   * The file has `<en-export>` but never closes it: it stops early, so notes after the cut weren't in it. Also set
   * when the cut falls between two notes, which leaves no half note to show for it. Added as `file_cut_off`.
   */
  cutOff: boolean;
  warnings: NoteWarning[];
  bytesRead: number;
}

export interface ReadEnexOptions {
  /** Where resource bytes go. Without one, bytes are only hashed. */
  sink?: ResourceSink;
  /** Index mode: titles, dates and GUIDs only; content and resource data are skipped. */
  index?: boolean;
  /** Ordinal of the first note in this stream (when resuming). */
  firstOrdinal?: number;
  /** Notes with a lower ordinal are parsed lightly and not returned. */
  skipBefore?: number;
  /** The stream starts at this byte offset of the file, which must be a note boundary. */
  startOffset?: number;
}

export interface EnexReader {
  notes: AsyncGenerator<EnexNote, void, undefined>;
  info: EnexFileInfo;
}

interface Capture {
  depth: number;
  parts: string[];
  size: number;
  limit: number;
  truncated: boolean;
  done: (text: string, truncated: boolean) => void;
}

interface DataTarget {
  depth: number;
  decoder: Base64StreamDecoder;
  md5: Hash;
  sha256: Hash;
  size: number;
  sink: Writable | null;
  done: (digest: BinaryDigest, sink: Writable | null) => void;
}

interface NoteBuild {
  note: EnexNote;
  warnings: Warnings;
  skip: boolean;
  pending: Promise<unknown>[];
}

const num = (s: string): number | null => {
  const n = Number(s.trim());
  return s.trim() && Number.isFinite(n) ? n : null;
};

function completeUtf8Length(buf: Buffer): number {
  const end = buf.length;
  let i = end - 1;
  let continuation = 0;
  while (i >= 0 && continuation < 3 && ((buf[i] as number) & 0xc0) === 0x80) {
    i--;
    continuation++;
  }
  if (i < 0) return end;
  const lead = buf[i] as number;
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return end - i >= need ? end : i;
}

export function readEnex(input: Readable, options: ReadEnexOptions = {}): EnexReader {
  const info: EnexFileInfo = {
    exportRoot: false,
    application: null,
    version: null,
    exportDate: null,
    notesSeen: 0,
    truncated: null,
    cutOff: false,
    warnings: [],
    bytesRead: 0,
  };
  return { notes: run(input, options, info), info };
}

async function* run(input: Readable, opts: ReadEnexOptions, info: EnexFileInfo): AsyncGenerator<EnexNote> {
  const parser = sax.parser(true, { trim: false, normalize: false, position: true });
  const fileWarnings = new Warnings();
  let exportClosed = false;
  // Tags the parser closes on its own at the end of the input aren't in the file.
  let ending = false;
  const stack: string[] = [];
  const ready: NoteBuild[] = [];
  const drains = new Set<Writable>();
  let fatal: Error | null = null;
  let xmlErrors = 0;
  let ordinal = (opts.firstOrdinal ?? 0) - 1;
  let current: NoteBuild | null = null;
  let resource: EnexResource | null = null;
  let task: EnexTask | null = null;
  let reminder: Record<string, string> | null = null;
  let capture: Capture | null = null;
  let data: DataTarget | null = null;

  // Byte offsets: sax counts UTF-16 code units; map them back to file bytes through the current chunk.
  let charBase = 0;
  let byteBase = opts.startOffset ?? 0;
  let chunk = "";
  let offsetsExact = true;

  const byteAt = (position: number): number | null =>
    offsetsExact ? byteBase + Buffer.byteLength(chunk.slice(0, position - charBase), "utf8") : null;

  const warn = (code: string, detail?: string) => (current ? current.warnings : fileWarnings).add(code, detail);

  const startCapture = (limit: number, done: Capture["done"]) => {
    capture = { depth: stack.length, parts: [], size: 0, limit, truncated: false, done };
  };

  const startData = (kind: SinkMeta["kind"], done: DataTarget["done"]) => {
    const build = current as NoteBuild;
    let sink: Writable | null = null;
    if (opts.sink) {
      sink = opts.sink({ ordinal: build.note.ordinal, index: build.note.resources.length, kind });
      sink.on("error", (err: Error) => {
        fatal ??= err;
      });
    }
    data = {
      depth: stack.length,
      decoder: new Base64StreamDecoder(),
      md5: createHash("md5"),
      sha256: createHash("sha256"),
      size: 0,
      sink,
      done,
    };
  };

  const writeData = (buf: Buffer | null) => {
    if (!buf?.length || !data) return;
    data.md5.update(buf);
    data.sha256.update(buf);
    data.size += buf.length;
    if (data.sink && !data.sink.write(buf)) drains.add(data.sink);
  };

  const endData = () => {
    const d = data as DataTarget;
    data = null;
    const tail = d.decoder.end();
    if (tail?.length) {
      d.md5.update(tail);
      d.sha256.update(tail);
      d.size += tail.length;
      if (d.sink && !d.sink.write(tail)) drains.add(d.sink);
    }
    if (d.decoder.invalid) warn("bad_base64", `${d.decoder.invalid} invalid characters`);
    if (d.sink) {
      d.sink.end();
      const done = finished(d.sink);
      // Awaited when the note is handed over; if reading stops first, the rejection must not go unhandled.
      done.catch(() => {});
      current?.pending.push(done);
    }
    d.done({ md5: d.md5.digest("hex"), sha256: d.sha256.digest("hex"), size: d.size }, d.sink);
  };

  parser.onerror = (err) => {
    xmlErrors++;
    warn("xml_error", err.message.split("\n")[0]);
    if (xmlErrors > MAX_XML_ERRORS)
      fatal ??= new EnexFormatError(`ENEX file is not readable XML (${xmlErrors} errors)`);
    parser.resume();
  };

  parser.onopentag = (tag) => {
    const name = tag.name;
    const attrs = tag.attributes as Record<string, string>;
    // A damaged export can leave a container unclosed (`</note-attributesv>`); the strict parser then nests the
    // note's own fields inside it. A note-level field never belongs there, so close the container first.
    const container = stack[stack.length - 1];
    if (stack.length >= 3 && stack[1] === "note" && NOTE_LEVEL.has(name) && container && REPAIRABLE.has(container)) {
      if (!(container === "note-custom-metadata" && name === "guid")) {
        warn("xml_error", `<${name}> inside unclosed <${container}>: repaired`);
        while (stack.length > 2) closeTop();
      }
    }
    stack.push(name);
    const depth = stack.length;
    if (depth === 1) {
      if (name === "en-export") {
        info.exportRoot = true;
        info.application = attrs.application ?? null;
        info.version = attrs.version ?? null;
        info.exportDate = attrs["export-date"] ?? null;
      }
      return;
    }
    if (depth === 2) {
      if (name === "note") openNote();
      return;
    }
    const build = current;
    if (!build || stack[1] !== "note") return;
    if (/aes/i.test(attrs.encoding ?? "")) build.note.encryptedExport = true;
    if (build.skip) return;
    const note = build.note;
    const index = !!opts.index;

    if (depth === 3) {
      switch (name) {
        case "title":
          return startCapture(CAPTURE_LIMIT, (t) => {
            note.title = t.replace(/\s+/g, " ").trim();
          });
        case "guid":
          return startCapture(CAPTURE_LIMIT, (t) => {
            note.guid = t.trim() || note.guid;
          });
        case "created":
        case "updated":
          return startCapture(CAPTURE_LIMIT, (t) => {
            if (name === "created") note.createdRaw = t.trim();
            else note.updatedRaw = t.trim();
          });
        case "content":
          if (index) return;
          return startCapture(CONTENT_LIMIT, (t, truncated) => {
            note.content = t;
            if (truncated) build.warnings.add("oversized_content", "content over 64 MB was cut");
          });
        case "tag":
          if (index) return;
          return startCapture(CAPTURE_LIMIT, (t) => {
            const tag = t.trim();
            if (tag) note.tags.push(tag);
          });
        case "note-attributes":
        case "note-custom-metadata":
          return;
        case "resource":
          if (index) return;
          resource = {
            index: note.resources.length,
            hasData: false,
            digest: { md5: "d41d8cd98f00b204e9800998ecf8427e", sha256: EMPTY_SHA256, size: 0 },
            mime: null,
            width: null,
            height: null,
            duration: null,
            attributes: {},
            applicationData: {},
            recognition: null,
            alternate: null,
            sink: null,
            alternateSink: null,
          };
          return;
        case "task":
          if (index) return;
          task = {
            id: null,
            title: "",
            status: null,
            flag: false,
            sortWeight: null,
            groupId: null,
            dueDate: null,
            fields: {},
            reminders: [],
          };
          return;
        default:
          if (index) return;
          return startCapture(CAPTURE_LIMIT, (t) => {
            note.extra[name] = t.trim();
          });
      }
    }

    const parent = stack[2];
    if (depth === 4 && parent === "note-attributes" && !index) {
      const key = name === "application-data" ? attrs.key : null;
      return startCapture(CAPTURE_LIMIT, (t) => {
        if (key !== null) note.applicationData[key ?? ""] = t;
        else note.attributes[name] = t.trim();
      });
    }
    if (depth === 4 && parent === "note-custom-metadata") {
      return startCapture(CAPTURE_LIMIT, (t) => {
        note.customMetadata[name] = t.trim();
        if (name === "guid" && t.trim() && !note.guid) note.guid = t.trim();
      });
    }
    if (parent === "resource" && resource) {
      const r = resource;
      if (depth === 4) {
        switch (name) {
          case "data":
            r.hasData = true;
            return startData("data", (digest, sink) => {
              r.digest = digest;
              r.sink = sink;
            });
          case "alternate-data":
            return startData("alternate", (digest, sink) => {
              r.alternate = digest;
              r.alternateSink = sink;
            });
          case "mime":
            return startCapture(CAPTURE_LIMIT, (t) => {
              r.mime = t.trim().toLowerCase() || null;
            });
          case "width":
          case "height":
          case "duration":
            return startCapture(CAPTURE_LIMIT, (t) => {
              const v = num(t);
              r[name] = v === null ? null : Math.round(v);
            });
          case "recognition":
            return startCapture(RECOGNITION_LIMIT, (t) => {
              if (!t.trim()) return;
              try {
                const reco = parseRecoIndex(t);
                r.recognition = { xml: t, ...reco };
              } catch {
                build.warnings.add("recognition_unreadable", r.attributes["file-name"] ?? null);
                r.recognition = { xml: t, text: "", items: 0, lang: null, docType: null, objType: null };
              }
            });
          case "resource-attributes":
            return;
          default:
            return startCapture(CAPTURE_LIMIT, (t) => {
              r.attributes[name] = t.trim();
            });
        }
      }
      if (depth === 5 && stack[3] === "resource-attributes") {
        const key = name === "application-data" ? attrs.key : null;
        return startCapture(CAPTURE_LIMIT, (t) => {
          if (key !== null) r.applicationData[key ?? ""] = t;
          else r.attributes[name] = t.trim();
        });
      }
      return;
    }
    if (parent === "task" && task) {
      const tk = task;
      if (depth === 4 && name === "reminder") {
        reminder = {};
        return;
      }
      if (depth === 4) {
        return startCapture(CAPTURE_LIMIT, (t) => {
          tk.fields[name] = t;
        });
      }
      if (depth === 5 && reminder) {
        const rem = reminder;
        return startCapture(CAPTURE_LIMIT, (t) => {
          rem[name] = t;
        });
      }
    }
  };

  const openNote = () => {
    ordinal++;
    info.notesSeen++;
    const skip = ordinal < (opts.skipBefore ?? 0);
    current = {
      note: {
        ordinal,
        title: "",
        content: "",
        created: null,
        updated: null,
        createdRaw: null,
        updatedRaw: null,
        tags: [],
        attributes: {},
        applicationData: {},
        tasks: [],
        resources: [],
        guid: null,
        customMetadata: {},
        extra: {},
        encryptedExport: false,
        warnings: [],
        byteEnd: null,
      },
      warnings: new Warnings(),
      skip,
      pending: [],
    };
  };

  const closeNote = () => {
    const build = current as NoteBuild;
    current = null;
    const note = build.note;
    note.byteEnd = byteAt(parser.position);
    if (build.skip) return;
    if (note.content.includes("\u0000") || note.title.includes("\u0000")) {
      note.content = note.content.replaceAll("\u0000", "");
      note.title = note.title.replaceAll("\u0000", "");
      build.warnings.add("control_chars_removed", "NUL");
    }
    if (note.content.length > ENML_MAX_CHARS)
      build.warnings.add("oversized_content", `${note.content.length} characters`);
    for (const [field, raw] of [
      ["created", note.createdRaw],
      ["updated", note.updatedRaw],
    ] as const) {
      const date = parseEnexDate(raw);
      if (field === "created") note.created = date;
      else note.updated = date;
      if (raw === null || raw === "") {
        if (!opts.index) build.warnings.add("missing_date", field);
      } else if (!date) build.warnings.add("invalid_date", `${field}: ${raw.slice(0, 40)}`);
    }
    for (const r of note.resources) {
      if (!r.hasData) build.warnings.add("resource_without_data", r.attributes["file-name"] ?? r.mime ?? null);
      else if (r.digest.size === 0) build.warnings.add("empty_resource", r.attributes["file-name"] ?? r.mime ?? null);
      if (r.digest.size > RESOURCE_MAX_BYTES)
        build.warnings.add("oversized_resource", `${r.attributes["file-name"] ?? r.mime}: ${r.digest.size} bytes`);
    }
    note.warnings = build.warnings.list();
    ready.push(build);
  };

  // Closes are matched against our own stack: a tag already closed by a repair is ignored, and closing an
  // outer tag closes everything still open inside it.
  parser.onclosetag = (name) => {
    if (name === "en-export" && !ending) exportClosed = true;
    const at = stack.lastIndexOf(name);
    if (at < 0) return;
    while (stack.length > at) closeTop();
  };

  function closeTop(): void {
    const name = stack[stack.length - 1] as string;
    const depth = stack.length;
    if (data && depth === data.depth) endData();
    else if (capture && depth === capture.depth) {
      const c = capture;
      capture = null;
      c.done(c.parts.join(""), c.truncated);
    }
    if (current && stack[1] === "note") {
      if (depth === 2 && name === "note") closeNote();
      else if (depth === 3 && name === "resource" && resource) {
        current.note.resources.push(resource);
        resource = null;
      } else if (depth === 3 && name === "task" && task) {
        const f = task.fields;
        task.id = f.noteLevelID?.trim() || null;
        task.title = (f.title ?? "").trim();
        task.status = f.taskStatus?.trim() || null;
        task.flag = /^\s*true\s*$/i.test(f.taskFlag ?? "");
        task.sortWeight = f.sortWeight ?? null;
        task.groupId = f.taskGroupNoteLevelID?.trim() || null;
        task.dueDate = parseEnexDate(f.dueDate);
        current.note.tasks.push(task);
        task = null;
      } else if (depth === 4 && name === "reminder" && task && reminder) {
        task.reminders.push(reminder);
        reminder = null;
      }
    }
    stack.pop();
  }

  const onText = (t: string) => {
    if (data) {
      writeData(data.decoder.push(t));
      return;
    }
    const c = capture as Capture | null;
    if (!c || c.truncated) return;
    if (c.size + t.length > c.limit) {
      c.parts.push(t.slice(0, c.limit - c.size));
      c.size = c.limit;
      c.truncated = true;
      return;
    }
    c.parts.push(t);
    c.size += t.length;
  };
  parser.ontext = onText;
  parser.oncdata = onText;

  const feed = (str: string, bytes: number) => {
    charBase = parser.position;
    chunk = str;
    parser.write(str);
    // sax (1.6.1) is meant to flush long text every 64 KB, but after a <!DOCTYPE> its buffer check becomes NaN
    // and never runs again, so a whole attachment's base64 would pile up in one string. Flush every chunk.
    parser.flush();
    byteBase += bytes;
    info.bytesRead += bytes;
  };

  if (opts.startOffset) {
    parser.write(RESUME_PREFIX);
  }

  const settle = async () => {
    if (fatal) throw fatal;
    if (drains.size) {
      const waits = [...drains].map((s) =>
        s.writableEnded ? finished(s) : s.writableNeedDrain ? once(s, "drain") : Promise.resolve(),
      );
      drains.clear();
      await Promise.all(waits);
    }
    if (fatal) throw fatal;
  };

  let completed = false;
  try {
    yield* readChunks();
    completed = true;
  } finally {
    // The consumer stopped early (a crash, an abort): release the file and any half-written blob.
    if (!completed) {
      (data as DataTarget | null)?.sink?.destroy();
      input.destroy();
    }
  }

  async function* readChunks(): AsyncGenerator<EnexNote> {
    let carry: Buffer = Buffer.alloc(0);
    for await (const raw of input) {
      const piece = typeof raw === "string" ? Buffer.from(raw) : (raw as Buffer);
      const buf = carry.length ? Buffer.concat([carry, piece]) : piece;
      const cut = completeUtf8Length(buf);
      carry = Buffer.from(buf.subarray(cut));
      const str = buf.toString("utf8", 0, cut);
      // Invalid UTF-8 decodes to U+FFFD, which changes byte lengths: from then on offsets are unknown.
      if (offsetsExact && Buffer.byteLength(str, "utf8") !== cut) {
        offsetsExact = false;
        fileWarnings.add("xml_error", "invalid UTF-8");
      }
      feed(str, cut);
      await settle();
      while (ready.length) {
        const build = ready.shift() as NoteBuild;
        await Promise.all(build.pending);
        yield build.note;
      }
    }
    if (carry.length) {
      offsetsExact = false;
      feed(carry.toString("utf8"), carry.length);
    }
    ending = true;
    parser.close();
    if (info.exportRoot && !exportClosed) {
      info.cutOff = true;
      fileWarnings.add("file_cut_off");
    }
    if (current) {
      const open = current as NoteBuild;
      info.truncated = { ordinal: open.note.ordinal, title: open.note.title };
      if (data) {
        const d = data as DataTarget;
        d.sink?.end();
        data = null;
      }
    }
    await settle();
    while (ready.length) {
      const build = ready.shift() as NoteBuild;
      await Promise.all(build.pending);
      yield build.note;
    }
    info.warnings = fileWarnings.list();
  }
}

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
