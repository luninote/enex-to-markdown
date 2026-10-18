import type { JSONContent } from "@tiptap/core";
import { SCHEMA_VERSION } from "./version.ts";

export interface NoteContent {
  schema_version: number;
  doc: JSONContent;
}

type Step = (doc: JSONContent) => JSONContent;

/** `STEPS[v]` turns a version-v document into a version v+1 one. Every SCHEMA_VERSION bump adds one. */
const STEPS: Record<number, Step> = {
  // v2 added the image node, taskItem.taskId/due/flagged and webClip.sanitizerVersion. All optional with
  // defaults, so a v1 document is already a valid v2 one.
  1: (doc) => doc,
  // v3 added textAlign and indent on paragraphs and headings, and the subscript and superscript marks. The
  // attributes default to none, so a v2 document is already a valid v3 one.
  2: (doc) => doc,
};

export class NewerSchemaError extends Error {
  readonly schemaVersion: number;
  constructor(schemaVersion: number) {
    super(`note uses schema version ${schemaVersion}; this client knows up to ${SCHEMA_VERSION}`);
    this.schemaVersion = schemaVersion;
  }
}

/** Notes from a newer client open read-only: saving them here would drop what this schema can't hold. */
export function canEdit(schemaVersion: number): boolean {
  return schemaVersion <= SCHEMA_VERSION;
}

/** Brings stored content up to SCHEMA_VERSION. Throws NewerSchemaError for content from a newer client. */
export function migrateContent(content: NoteContent): NoteContent {
  const from = content.schema_version;
  if (!Number.isInteger(from) || from < 1) throw new Error(`invalid schema version ${String(from)}`);
  if (from > SCHEMA_VERSION) throw new NewerSchemaError(from);
  let doc = content.doc;
  for (let v = from; v < SCHEMA_VERSION; v++) {
    const step = STEPS[v];
    if (!step) throw new Error(`no migration from schema version ${v}`);
    doc = step(doc);
  }
  return { schema_version: SCHEMA_VERSION, doc };
}

// ProseMirror's toJSON writes every attribute, defaults included. These were added after v1; leaving them out
// at their default keeps v1-shaped nodes byte-identical when they are saved again, and the JSON small.
const OMITTED_DEFAULTS: Record<string, Record<string, unknown>> = {
  taskItem: { taskId: null, due: null, flagged: false },
  paragraph: { textAlign: null, indent: 0 },
  heading: { textAlign: null, indent: 0 },
  webClip: { sanitizerVersion: null },
};

/** Drops attributes that are at a default listed in OMITTED_DEFAULTS. Loading the result gives the same document. */
export function compactDoc(doc: JSONContent): JSONContent {
  const omit = doc.type ? OMITTED_DEFAULTS[doc.type] : undefined;
  let attrs = doc.attrs;
  if (omit && attrs) {
    const kept = Object.entries(attrs).filter(([k, v]) => !(k in omit && omit[k] === v));
    attrs = kept.length ? Object.fromEntries(kept) : undefined;
  }
  const out: JSONContent = { ...doc };
  if (attrs) out.attrs = attrs;
  else delete out.attrs;
  if (doc.content) out.content = doc.content.map(compactDoc);
  return out;
}

export function toNoteContent(doc: JSONContent): NoteContent {
  return { schema_version: SCHEMA_VERSION, doc: compactDoc(doc) };
}
