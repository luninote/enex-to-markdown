import type { FileKind } from "./fileKind.ts";

/**
 * The words the editor's own pieces show (attachment cards, image placeholders, web clip bars, chips). English by
 * default; the app replaces them from its translations once at startup (`setEditorLabels`), since the language is
 * the same for every editor on the page. Read at render time, so a node view drawn later uses the current words.
 */
export interface EditorLabels {
  imageFailed: string;
  openInNewTab: (name: string | null) => string;
  untitledAttachment: string;
  encrypted: string;
  encryptedHint: (hint: string) => string;
  unsupported: string;
  unsupportedKept: string;
  imageUnavailable: (alt: string | null) => string;
  remoteImage: string;
  loadRemoteImages: string;
  webClipReadOnly: string;
  webClipConvert: string;
  webClipFrameTitle: string;
  fileKind: Record<FileKind, string>;
}

const ENGLISH: EditorLabels = {
  imageFailed: "This image didn't load. Open it in a new tab to try again.",
  openInNewTab: (name) => `Open ${name ?? "attachment"} in a new tab`,
  untitledAttachment: "Untitled attachment",
  encrypted: "Encrypted text",
  encryptedHint: (hint) => `Hint: ${hint}`,
  unsupported: "Unsupported content",
  unsupportedKept: "Unsupported content (kept)",
  imageUnavailable: (alt) => (alt ? `Image not available: ${alt}` : "Image not available"),
  remoteImage: "Remote image",
  loadRemoteImages: "Load remote images",
  webClipReadOnly: "Web clip (read-only)",
  webClipConvert: "Convert to editable",
  webClipFrameTitle: "Web clip",
  fileKind: {
    image: "Image",
    pdf: "PDF document",
    audio: "Audio",
    video: "Video",
    document: "Document",
    spreadsheet: "Spreadsheet",
    presentation: "Presentation",
    archive: "Archive",
    other: "File",
  },
};

let current: EditorLabels = ENGLISH;

export function setEditorLabels(labels: Partial<EditorLabels>): void {
  current = { ...ENGLISH, ...labels, fileKind: { ...ENGLISH.fileKind, ...labels.fileKind } };
}

export const editorLabels = (): EditorLabels => current;
