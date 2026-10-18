import type { Progress, RunOptions, RunSummary } from "../core.ts";

/** The options a page can set; the rest are fixed for the browser. */
export type BrowserOptions = Pick<
  RunOptions,
  "obsidian" | "keepColors" | "keepClipHtml" | "datePrefix" | "frontMatter" | "passwords" | "fuzzyLinks" | "mergeParts"
>;

export interface InputFile {
  file: File;
  /** Folder of the file inside the folder chosen ("Stack"), "" at the top. */
  relDir: string;
  /** The file's path as chosen ("Evernote/Stack/Work.enex"), for messages and the warnings file. */
  label: string;
}

export interface StartMessage {
  type: "start";
  files: InputFile[];
  options: BrowserOptions;
  /** Where to stream the ZIP; without one, it is built as a Blob and sent back. */
  target: FileSystemFileHandle | null;
}

export interface CancelMessage {
  type: "cancel";
}

export type ToWorker = StartMessage | CancelMessage;

export type FromWorker =
  | { type: "progress"; progress: Progress }
  | { type: "done"; summary: RunSummary; warnings: string | null; zip: Blob | null }
  | { type: "cancelled" }
  | { type: "error"; message: string };
