import { cdata, element, enexDate, escapeAttr, escapeText } from "./xml.ts";

// A streaming ENEX writer (Evernote's export format, evernote-export4.dtd): one `<en-export>` per notebook, written
// note by note, attachment bytes base64-encoded as they are read. Nothing holds a whole notebook or attachment.

export interface EnexResourceOut {
  /** The attachment's bytes, read when the note is written. Null writes the resource without `<data>`. */
  data: (() => AsyncIterable<Uint8Array>) | null;
  mime: string;
  width?: number | null;
  height?: number | null;
  duration?: number | null;
  /** Evernote's recognition XML (recoIndex) as it came with the attachment. */
  recognition?: string | null;
  /** `<resource-attributes>` children, in order (file-name, source-url, timestamp, …). */
  attributes?: [string, string][];
  applicationData?: Record<string, string>;
}

export interface EnexTaskOut {
  /** `<task>` children in order (title, created, taskStatus, noteLevelID, …). */
  fields: [string, string][];
  reminders?: Record<string, string>[];
}

export interface EnexNoteOut {
  title: string;
  /** A complete ENML document (with its XML declaration and doctype). */
  enml: string;
  created: Date | string;
  updated: Date | string;
  tags: string[];
  /** Written as `<guid>` (as evernote-backup does), so links between notes survive a re-import into LuniNote. */
  guid?: string | null;
  /** `<note-attributes>` children in order (author, source, source-url, reminder-time, …). */
  attributes?: [string, string][];
  applicationData?: Record<string, string>;
  resources: EnexResourceOut[];
  tasks?: EnexTaskOut[];
}

export function enexHeader(exportDate: Date, application = "LuniNote", version = "1"): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE en-export SYSTEM "http://xml.evernote.com/pub/evernote-export4.dtd">
<en-export export-date="${enexDate(exportDate)}" application="${escapeAttr(application)}" version="${escapeAttr(version)}">
`;
}

export const ENEX_FOOTER = "</en-export>\n";

export type Base64Encoder = (bytes: Uint8Array) => string;

/** Portable base64 (browser and Node); callers in Node pass Buffer's faster encoder. */
export const encodeBase64: Base64Encoder = (bytes) => {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...(bytes.subarray(i, i + 0x8000) as unknown as number[]));
  return btoa(bin);
};

const LINE = 76;
const LINE_BYTES = (LINE / 4) * 3;

/** Base64 in 76-character lines, as Evernote writes it, without ever holding more than one chunk. */
export async function* base64Lines(
  chunks: AsyncIterable<Uint8Array>,
  encode: Base64Encoder = encodeBase64,
): AsyncGenerator<string> {
  let carry = new Uint8Array(0);
  for await (const chunk of chunks) {
    const all = carry.length ? concat(carry, chunk) : chunk;
    const whole = all.length - (all.length % LINE_BYTES);
    if (whole) yield wrap(encode(all.subarray(0, whole)));
    carry = all.slice(whole);
  }
  if (carry.length) yield wrap(encode(carry));
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function wrap(b64: string): string {
  let out = "";
  for (let i = 0; i < b64.length; i += LINE) out += `${b64.slice(i, i + LINE)}\n`;
  return out;
}

const children = (pairs: [string, string][] | undefined) =>
  (pairs ?? [])
    .filter(([k]) => /^[a-zA-Z][\w.-]*$/.test(k))
    .map(([k, v]) => element(k, v))
    .join("");

const appData = (data: Record<string, string> | undefined) =>
  Object.entries(data ?? {})
    .map(([k, v]) => `<application-data key="${escapeAttr(k)}">${escapeText(v)}</application-data>`)
    .join("");

/** One `<note>`, in pieces: attachment data streams through as it's read. */
export async function* enexNote(note: EnexNoteOut, encode?: Base64Encoder): AsyncGenerator<string> {
  let head = `<note><title>${escapeText(note.title)}</title>`;
  if (note.guid) head += element("guid", note.guid);
  head += `<content>${cdata(note.enml)}</content>`;
  head += element("created", enexDate(note.created));
  head += element("updated", enexDate(note.updated));
  for (const t of note.tags) head += element("tag", t);
  const attrs = children(note.attributes) + appData(note.applicationData);
  if (attrs) head += `<note-attributes>${attrs}</note-attributes>`;
  yield head;
  for (const r of note.resources) {
    yield "<resource>";
    if (r.data) {
      yield '<data encoding="base64">\n';
      yield* base64Lines(r.data(), encode);
      yield "</data>";
    }
    let tail = element("mime", r.mime);
    if (r.width) tail += element("width", String(r.width));
    if (r.height) tail += element("height", String(r.height));
    if (r.duration) tail += element("duration", String(r.duration));
    if (r.recognition) tail += `<recognition>${cdata(r.recognition)}</recognition>`;
    const ra = children(r.attributes) + appData(r.applicationData);
    if (ra) tail += `<resource-attributes>${ra}</resource-attributes>`;
    yield `${tail}</resource>`;
  }
  let tasks = "";
  for (const t of note.tasks ?? []) {
    tasks += `<task>${children(t.fields)}`;
    for (const rem of t.reminders ?? []) tasks += `<reminder>${children(Object.entries(rem))}</reminder>`;
    tasks += "</task>";
  }
  yield `${tasks}</note>\n`;
}
