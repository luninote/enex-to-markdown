// The JSON archive: everything LuniNote stores about an account, lossless, in a documented, versioned layout.
// `luninote-export.json` holds the account-wide data; each note is its own `notes/<id>.json`, so a
// reader never has to load the whole account at once. Attachment bytes are the shared `attachments/` files.

export const ARCHIVE_FORMAT = "luninote-export";
/** Bumped on any change a reader of an older version would get wrong; additions of fields don't bump it. */
export const ARCHIVE_VERSION = 1;
export const MANIFEST_FILE = "luninote-export.json";
export const README_FILE = "README.txt";

export type ExportFormat = "enex" | "html" | "markdown" | "json";
export const EXPORT_FORMATS: readonly ExportFormat[] = ["enex", "html", "markdown", "json"];

export interface ArchiveNotebook {
  id: string;
  name: string;
  stack: string | null;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
  /** This notebook's ENEX file in the archive, when ENEX was exported. */
  enexFile: string | null;
}

export interface ArchiveTag {
  id: string;
  name: string;
  parentId: string | null;
  /** Set on a tag that was merged into another (kept so offline changes naming it still land). */
  mergedInto: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ArchiveSavedSearch {
  id: string;
  name: string;
  query: string;
  createdAt: string;
  updatedAt: string;
}

export interface ArchiveShortcut {
  id: string;
  targetType: "note" | "notebook" | "stack" | "tag" | "saved_search";
  /** An entity id, or the stack's name for a stack. */
  targetId: string;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface ArchiveResource {
  id: string;
  /** The note the attachment belongs to (a conflict copy shows its original's attachments). */
  noteId: string;
  sha256: string;
  md5: string | null;
  size: number | null;
  mime: string;
  filename: string | null;
  width: number | null;
  height: number | null;
  duration: number | null;
  sourceUrl: string | null;
  /** OCR text (Evernote's recognition data on import, or ours). */
  recognitionText: string | null;
  extractedText: string | null;
  /** Everything else known about the attachment (original resource attributes, recognition XML, …). */
  attributes: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  /** The bytes in the archive, or null when the file is missing from storage (listed in the manifest). */
  file: string | null;
}

export interface ArchiveRevision {
  version: number;
  baseVersion: number | null;
  schemaVersion: number;
  createdAt: string;
  deviceId: string | null;
  flags: string[];
  document: unknown;
}

export interface ArchiveHistoryEntry {
  id: string;
  version: number;
  title: string;
  tagIds: string[];
  reason: string;
  createdAt: string;
}

export interface ArchiveNote {
  id: string;
  notebookId: string;
  title: string;
  tagIds: string[];
  createdAt: string;
  updatedAt: string;
  trashedAt: string | null;
  conflictOf: string | null;
  source: string | null;
  sourceUrl: string | null;
  sourceApp: string | null;
  author: string | null;
  latitude: number | null;
  longitude: number | null;
  altitude: number | null;
  /** A 64-bit integer, as a string. */
  reminderOrder: string | null;
  reminderAt: string | null;
  reminderDoneAt: string | null;
  isTemplate: boolean;
  /** Search flags derived from the document (bitset). */
  flags: number;
  snippet: string;
  contentHash: string | null;
  version: number;
  schemaVersion: number;
  /** ProseMirror JSON in the `packages/editor` schema of `schemaVersion`, exactly as stored. */
  document: unknown;
  revision: { createdAt: string; deviceId: string | null; baseVersion: number | null; flags: string[] } | null;
  /** Every attachment the note owns or shows. */
  resources: ArchiveResource[];
  /** Attachments any version of this note shows. */
  resourceRefs: string[];
  /** The note as it was imported: its original ENML file and everything the import kept that has no column. */
  original: { format: string; file: string | null; meta: unknown; createdAt: string } | null;
  history?: { entries: ArchiveHistoryEntry[]; revisions: ArchiveRevision[] };
  files: { html: string | null; markdown: string | null; enex: string | null };
}

export interface ArchiveManifest {
  format: typeof ARCHIVE_FORMAT;
  version: number;
  application: string;
  exportedAt: string;
  options: { formats: ExportFormat[]; includeTrash: boolean; includeHistory: boolean };
  counts: {
    notebooks: number;
    stacks: number;
    tags: number;
    savedSearches: number;
    shortcuts: number;
    notes: number;
    trashedNotes: number;
    attachments: number;
    attachmentBytes: number;
  };
  notebooks: ArchiveNotebook[];
  stacks: string[];
  tags: ArchiveTag[];
  savedSearches: ArchiveSavedSearch[];
  shortcuts: ArchiveShortcut[];
  /** Attachments whose bytes weren't in storage: listed instead of silently missing. */
  missingAttachments: { sha256: string; resourceIds: string[] }[];
  /** Things a format couldn't hold, per note (`note id: code: detail`), the first 1,000. */
  warnings: string[];
}
