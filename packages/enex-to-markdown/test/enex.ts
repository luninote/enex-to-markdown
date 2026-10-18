import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const md5 = (b: Buffer) => createHash("md5").update(b).digest("hex");

export interface ResourceSpec {
  data: Buffer | null;
  mime: string;
  fileName?: string;
}

export interface NoteSpec {
  title: string;
  /** Inner ENML of <en-note>. */
  body?: string;
  tags?: string[];
  attributes?: Record<string, string>;
  resources?: ResourceSpec[];
  /** Raw XML added inside <note> (tasks, a guid). */
  extra?: string;
  created?: string;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function resourceXml(r: ResourceSpec): string {
  const data = r.data === null ? "" : `<data encoding="base64">${r.data.toString("base64")}</data>`;
  const attrs = r.fileName
    ? `<resource-attributes><file-name>${esc(r.fileName)}</file-name></resource-attributes>`
    : "";
  return `<resource>${data}<mime>${r.mime}</mime>${attrs}</resource>`;
}

export function noteXml(n: NoteSpec): string {
  const tags = (n.tags ?? []).map((t) => `<tag>${esc(t)}</tag>`).join("");
  const attrs = Object.entries(n.attributes ?? {})
    .map(([k, v]) => `<${k}>${esc(v)}</${k}>`)
    .join("");
  const content = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd"><en-note>${n.body ?? "<div>text</div>"}</en-note>`;
  return `<note><title>${esc(n.title)}</title><content><![CDATA[${content}]]></content><created>${n.created ?? "20240102T030405Z"}</created><updated>20240103T030405Z</updated>${tags}${attrs ? `<note-attributes>${attrs}</note-attributes>` : ""}${(n.resources ?? []).map(resourceXml).join("")}${n.extra ?? ""}</note>`;
}

export function enex(notes: (NoteSpec | string)[]): string {
  const inner = notes.map((n) => (typeof n === "string" ? n : noteXml(n))).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE en-export SYSTEM "http://xml.evernote.com/pub/evernote-export4.dtd">\n<en-export export-date="20240101T000000Z" application="Evernote" version="10.0">\n${inner}\n</en-export>\n`;
}

export async function tempDir(): Promise<{ path: string; done: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), "enex-md-"));
  return { path, done: () => rm(path, { recursive: true, force: true }) };
}

export const read = (path: string) => readFile(path, "utf8");
