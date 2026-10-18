import { type AnyExtension, getSchema } from "@tiptap/core";
import { Link } from "@tiptap/extension-link";
import { TaskList } from "@tiptap/extension-list";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import { FontFamily, FontSize, TextStyle } from "@tiptap/extension-text-style";
import type { Schema } from "@tiptap/pm/model";
import { StarterKit } from "@tiptap/starter-kit";
import { BlockFormat, Subscript, Superscript } from "./blockFormat.ts";
import { HighlightColor, TextColor } from "./colors.ts";
import { FileDrop, type FilesHandler } from "./fileDrop.ts";
import { LinkOpen, type LinkOpenHandler } from "./linkOpen.ts";
import { Attachment, Encrypted, Unsupported } from "./nodes/atoms.ts";
import { Image } from "./nodes/image.ts";
import { TaskItem } from "./nodes/taskItem.ts";
import { WebClip, type WebClipOptions } from "./nodes/webClip.ts";
import { LargePaste, type LargePasteOptions } from "./paste.ts";
import { RemoteContent } from "./remote.ts";
import type { EditorResources } from "./resources.ts";
import { FamiliarShortcuts } from "./shortcuts.ts";
import { Surface } from "./surface.ts";

export { SCHEMA_VERSION } from "./version.ts";

export interface EditorExtensionOptions {
  onWebClipRendered?: WebClipOptions["onRendered"];
  onLargePaste?: LargePasteOptions["onLargePaste"];
  largePasteThreshold?: number;
  /** Where attachment bytes come from. Without it attachments render as plain file cards that open nothing. */
  resources?: EditorResources;
  /** The user's setting to load http(s) images and remote clip content without asking. Default false. */
  loadRemoteImages?: boolean;
  /** A link was opened (Ctrl/⌘-click, or a click in a read-only note). Without it links don't open. */
  onOpenLink?: LinkOpenHandler;
  /** Files dropped or pasted into the editor (see `FileDrop`). HTML pastes never come here. */
  onFiles?: FilesHandler;
  placeholder?: string;
}

export function createEditorExtensions(options: EditorExtensionOptions = {}): AnyExtension[] {
  return [
    StarterKit.configure({
      // The trailing-paragraph plugin rewrites documents that end in a table or clip on load; stored notes must not change by being opened.
      trailingNode: false,
      link: false,
    }),
    // Tiptap makes links inclusive when autolink is on, so text typed after a link joined it.
    Link.extend({ inclusive: () => false }).configure({
      openOnClick: false,
      autolink: true,
      // Unresolved links from Evernote imports must survive rendering and copy/paste.
      protocols: ["evernote"],
      HTMLAttributes: { target: null, rel: null, class: null },
    }),
    LinkOpen.configure({ onOpen: options.onOpenLink ?? null }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    HighlightColor,
    Subscript,
    Superscript,
    BlockFormat,
    TextStyle,
    TextColor,
    FontFamily,
    FontSize,
    Attachment.configure({ resources: options.resources ?? null }),
    Image,
    Encrypted,
    Unsupported,
    WebClip.configure({ onRendered: options.onWebClipRendered ?? null, resources: options.resources ?? null }),
    LargePaste.configure({
      onLargePaste: options.onLargePaste ?? null,
      ...(options.largePasteThreshold === undefined ? {} : { threshold: options.largePasteThreshold }),
    }),
    RemoteContent.configure({ loadRemoteImages: options.loadRemoteImages ?? false }),
    FamiliarShortcuts,
    FileDrop.configure({ onFiles: options.onFiles ?? null }),
    Surface.configure({ placeholder: options.placeholder ?? null }),
  ];
}

/**
 * Validates a stored document against this client's schema. Returns null when it loads safely.
 * Tiptap replaces content it can't parse (an unknown node or mark, e.g. from a newer schema) with an
 * empty document without throwing, so a caller must never open, and above all never save, a doc that fails here.
 */
export function checkDoc(doc: unknown): string | null {
  try {
    getEditorSchema().nodeFromJSON(doc).check();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

let cachedSchema: Schema | null = null;

/** The ProseMirror schema without an editor or a DOM (Node-safe). */
export function getEditorSchema(): Schema {
  cachedSchema ??= getSchema(createEditorExtensions());
  return cachedSchema;
}
