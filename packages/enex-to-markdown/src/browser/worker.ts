import { makeZip } from "client-zip";
import { convertSources, type EnexSource } from "../core.ts";
import { BROWSER_WORDING } from "../report.ts";
import type { FromWorker, StartMessage, ToWorker } from "./protocol.ts";
import { ZipOutput } from "./zip.ts";

// Runs one conversion off the page's thread: File objects in, a ZIP out, either streamed into the file the page was
// given or built as a Blob and handed back.

// Names are shortened as if the ZIP were unpacked into a Downloads folder
// ("C:\Users\<name>\Downloads\markdown-export\" is about 50 characters), with room to spare.
const ROOT_LENGTH = 64;
const CHUNK = 1 << 20;
const PROGRESS_EVERY_MS = 100;

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
  postMessage(message: FromWorker): void;
};

let controller: AbortController | null = null;

scope.onmessage = (event) => {
  if (event.data.type === "cancel") controller?.abort();
  else void run(event.data);
};

/** The file's bytes in pieces of about 1 MB (File.stream() gives much smaller ones). */
async function* chunks(file: Blob): AsyncGenerator<Uint8Array> {
  const reader = file.stream().getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  const take = () => {
    const out = new Uint8Array(size);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    parts.length = 0;
    size = 0;
    return out;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      size += value.length;
      if (size >= CHUNK) yield take();
    }
    if (size) yield take();
  } finally {
    await reader.cancel().catch(() => {});
  }
}

async function run(message: StartMessage): Promise<void> {
  controller = new AbortController();
  const signal = controller.signal;
  const output = new ZipOutput();
  const zip = makeZip(output.entries(), { buffersAreUTF8: true });
  const written: Promise<Blob | null> = message.target
    ? message.target
        .createWritable()
        .then((w) => zip.pipeTo(w))
        .then(() => null)
    : new Response(zip).blob();
  written.catch((err) => output.fail(err));

  const sources: EnexSource[] = message.files.map(({ file, relDir, label }) => ({
    name: file.name,
    label,
    relDir,
    size: file.size,
    open: () => chunks(file),
  }));
  let last = 0;
  try {
    const summary = await convertSources(sources, output, {
      ...message.options,
      rootLength: ROOT_LENGTH,
      wording: BROWSER_WORDING,
      signal,
      onProgress: (progress) => {
        const now = performance.now();
        if (now - last < PROGRESS_EVERY_MS) return;
        last = now;
        scope.postMessage({ type: "progress", progress });
      },
    });
    output.end();
    const zipBlob = await written;
    scope.postMessage({ type: "done", summary, warnings: output.warnings, zip: zipBlob });
  } catch (err) {
    output.fail(err);
    await written.catch(() => {});
    scope.postMessage(
      signal.aborted ? { type: "cancelled" } : { type: "error", message: (err as Error).message ?? String(err) },
    );
  }
}
