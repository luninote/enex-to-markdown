import type { Progress, RunSummary } from "../core.ts";
import type { BrowserOptions, FromWorker, InputFile, ToWorker } from "./protocol.ts";

// The page's side of the browser converter: gathering the files a person picked or dropped, choosing where the ZIP
// goes, and running the worker. Nothing here or in the worker sends anything over the network.

export type { Progress, RunSummary } from "../core.ts";
export type { BrowserOptions, InputFile } from "./protocol.ts";

export const ZIP_NAME = "markdown-export.zip";

/** A picked file and its path as picked: "Work.enex", or "Evernote/Stack/Work.enex" from a folder. */
export interface Picked {
  file: File;
  path: string;
}

/** Files from a file input; a folder input (`webkitdirectory`) gives their paths inside the folder. */
export function filesFromInput(list: FileList | readonly File[]): Picked[] {
  return Array.from(list, (file) => ({ file, path: file.webkitRelativePath || file.name }));
}

/**
 * Files from a drop, folders searched. Call it in the drop handler itself: the browser empties the drop's items once
 * the handler returns, and this reads them before its first wait.
 */
export function filesFromDrop(data: DataTransfer): Promise<Picked[]> {
  const entries = Array.from(data.items, (item) => item.webkitGetAsEntry?.() ?? null);
  const plain = Array.from(data.files);
  if (!entries.some(Boolean)) return Promise.resolve(filesFromInput(plain));
  return (async () => {
    const out: Picked[] = [];
    for (const entry of entries) if (entry) await walk(entry, out);
    return out;
  })();
}

async function walk(entry: FileSystemEntry, out: Picked[]): Promise<void> {
  const path = entry.fullPath.replace(/^\/+/, "");
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
    out.push({ file, path });
    return;
  }
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  const children: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) break;
    children.push(...batch);
  }
  for (const child of children) await walk(child, out);
}

const segments = (path: string) => path.split("/").filter(Boolean);

/**
 * The .enex files to convert, in the order the command line would take them: inside a folder sorted by name, folder
 * by folder; files and folders picked at the top in the order picked. `skipped` lists the other files.
 */
export function toInputs(picked: readonly Picked[]): { files: InputFile[]; skipped: string[] } {
  const seen = new Set<string>();
  const skipped: string[] = [];
  const groups = new Map<string, InputFile[]>();
  for (const { file, path } of picked) {
    const parts = segments(path);
    if (!/\.enex$/i.test(file.name)) {
      skipped.push(path);
      continue;
    }
    const key = `${path}\u0000${file.size}\u0000${file.lastModified}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const top = parts.length > 1 ? `${parts[0]}/` : path;
    const input: InputFile = { file, relDir: parts.slice(1, -1).join("/"), label: parts.join("/") };
    const group = groups.get(top);
    if (group) group.push(input);
    else groups.set(top, [input]);
  }
  const byName = (a: InputFile, b: InputFile) => {
    const x = segments(a.label);
    const y = segments(b.label);
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
      const c = (x[i] as string).localeCompare(y[i] as string);
      if (c) return c;
    }
    return x.length - y.length;
  };
  return { files: [...groups.values()].flatMap((g) => g.sort(byName)), skipped };
}

interface SavePickerWindow {
  showSaveFilePicker?: (options: {
    suggestedName?: string;
    types?: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<FileSystemFileHandle>;
}

/** True where the ZIP can stream straight to a file the person picks (Chromium browsers). */
export const canStreamToFile = () =>
  typeof (globalThis as SavePickerWindow).showSaveFilePicker === "function" && globalThis.isSecureContext;

/**
 * Asks where to save the ZIP. Call it straight from the click, before anything else waits: browsers allow the
 * picker only while the click is fresh. Null when the browser can't stream to a file; "cancelled" when the person
 * closed the picker.
 */
export async function chooseTarget(): Promise<FileSystemFileHandle | null | "cancelled"> {
  const picker = (globalThis as SavePickerWindow).showSaveFilePicker;
  if (!canStreamToFile() || !picker) return null;
  try {
    return await picker.call(globalThis, {
      suggestedName: ZIP_NAME,
      types: [{ description: "ZIP archive", accept: { "application/zip": [".zip"] } }],
    });
  } catch (err) {
    if ((err as DOMException).name === "AbortError") return "cancelled";
    return null;
  }
}

export type Outcome =
  | { status: "done"; summary: RunSummary; warnings: string | null; savedTo: "file" | "download" }
  | { status: "cancelled" }
  | { status: "error"; message: string };

export interface Conversion {
  result: Promise<Outcome>;
  cancel(): void;
}

/**
 * Loads the converter (dist/browser/enex-to-markdown-worker.js) ahead of a conversion, so that once it starts the page
 * makes no request at all. A worker runs one conversion at a time, and more after a finished one; after a cancel or an
 * error it is stopped and a new one is needed.
 */
export function loadWorker(url: string): Worker {
  const worker = new Worker(url, { name: "enex-to-markdown" });
  // A script that fails to load reports it once, possibly before any conversion listens.
  worker.addEventListener("error", (event) => failed.set(worker, event.message || "The converter didn't load."));
  return worker;
}

const failed = new WeakMap<Worker, string>();

export interface ConvertRequest {
  worker: Worker;
  files: InputFile[];
  options: BrowserOptions;
  target: FileSystemFileHandle | null;
  onProgress?: (progress: Progress) => void;
}

const CANCEL_GRACE_MS = 3000;

export function convert(request: ConvertRequest): Conversion {
  const { worker } = request;
  let settle: (outcome: Outcome) => void = () => {};
  let cancelTimer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  const result = new Promise<Outcome>((resolve) => {
    settle = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(cancelTimer);
      worker.onmessage = null;
      worker.onerror = null;
      if (outcome.status !== "done") {
        worker.terminate();
        if (request.target) void removeFile(request.target);
      }
      resolve(outcome);
    };
  });
  worker.onmessage = (event: MessageEvent<FromWorker>) => {
    const m = event.data;
    if (m.type === "progress") request.onProgress?.(m.progress);
    else if (m.type === "cancelled") settle({ status: "cancelled" });
    else if (m.type === "error") settle({ status: "error", message: m.message });
    else {
      if (m.zip) download(m.zip, ZIP_NAME);
      settle({ status: "done", summary: m.summary, warnings: m.warnings, savedTo: m.zip ? "download" : "file" });
    }
  };
  worker.onerror = (event) => {
    event.preventDefault();
    settle({ status: "error", message: event.message || "The converter stopped unexpectedly." });
  };
  const loadError = failed.get(worker);
  if (loadError) settle({ status: "error", message: loadError });
  const start: ToWorker = { type: "start", files: request.files, options: request.options, target: request.target };
  worker.postMessage(start);
  return {
    result,
    cancel() {
      worker.postMessage({ type: "cancel" } satisfies ToWorker);
      // A note being read finishes before the worker sees the cancel; a huge one may take a while.
      cancelTimer = setTimeout(() => settle({ status: "cancelled" }), CANCEL_GRACE_MS);
    },
  };
}

/** Removes the half-written ZIP after a cancel or an error, where the browser allows it. */
async function removeFile(handle: FileSystemFileHandle): Promise<void> {
  try {
    await (handle as FileSystemFileHandle & { remove?: () => Promise<void> }).remove?.();
  } catch {
    // The file stays, empty: the browser only writes the ZIP's bytes into it when the conversion finishes.
  }
}

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
  // The download has its own reference once it starts; revoking at once can cancel it in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
