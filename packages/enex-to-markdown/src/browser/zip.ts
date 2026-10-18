import { type Output, type Staged, WARNINGS_FILE } from "../core.ts";
import { Emitter } from "./shims/events.ts";

// Bytes a sink keeps as arrays before moving them into a Blob, which the browser may keep outside the worker's
// memory (on disk, for large ones).
const FOLD_BYTES = 8 << 20;

/** An attachment's bytes, held until its note is read; the shared reader writes to it like a Node stream. */
export class MemorySink extends Emitter {
  private blob = new Blob([]);
  private chunks: Uint8Array[] = [];
  private size = 0;
  writableEnded = false;
  writableFinished = false;
  readonly writableNeedDrain = false;
  closed = false;
  destroyed = false;

  write(chunk: Uint8Array): boolean {
    if (this.destroyed) return true;
    this.chunks.push(chunk);
    this.size += chunk.length;
    if (this.size >= FOLD_BYTES) this.fold();
    return true;
  }

  /** Everything written, once; the sink is empty afterwards. */
  take(): Blob {
    this.fold();
    const blob = this.blob;
    this.blob = new Blob([]);
    return blob;
  }

  private fold(): void {
    if (!this.chunks.length) return;
    this.blob = new Blob([this.blob, ...(this.chunks as BlobPart[])]);
    this.chunks = [];
    this.size = 0;
  }

  end(): this {
    this.writableEnded = true;
    this.writableFinished = true;
    this.closed = true;
    this.emit("finish");
    this.emit("close");
    return this;
  }

  destroy(): this {
    this.destroyed = true;
    this.chunks = [];
    this.blob = new Blob([]);
    this.closed = true;
    this.emit("close");
    return this;
  }
}

export interface ZipEntry {
  name: string;
  input?: string | Uint8Array | Blob;
  lastModified?: Date;
}

// How many entries may wait for the ZIP writer before the converter waits too. An entry is one note or attachment, so
// this bounds memory to a few of them however slow the disk is.
const QUEUE = 8;

/** Files go into a ZIP stream as they're written; `entries` is what the ZIP writer reads. */
export class ZipOutput implements Output {
  /** The text of the warnings file, for the page to show too. */
  warnings: string | null = null;
  private readonly queue: ZipEntry[] = [];
  private readonly folders = new Set<string>();
  private readonly now = new Date();
  private wake: (() => void) | null = null;
  private room: (() => void)[] = [];
  private ended = false;
  private error: unknown = null;

  stage(): Staged {
    return new MemorySink() as unknown as Staged;
  }

  async commit(staged: Staged, path: string): Promise<void> {
    const input = (staged as unknown as MemorySink).take();
    await this.push({ name: path, input, lastModified: this.now });
  }

  async discard(staged: Staged): Promise<void> {
    (staged as unknown as MemorySink).destroy();
  }

  async dir(path: string): Promise<void> {
    if (this.folders.has(path)) return;
    this.folders.add(path);
    await this.push({ name: `${path}/`, lastModified: this.now });
  }

  async write(path: string, data: string | Uint8Array, mtime: Date | null): Promise<void> {
    if (path === WARNINGS_FILE && typeof data === "string") this.warnings = data;
    await this.push({ name: path, input: data, lastModified: mtime ?? this.now });
  }

  end(): void {
    this.ended = true;
    this.signal();
  }

  /** Stops both sides: the converter's next write throws `error`, and the ZIP stream errors. */
  fail(error: unknown): void {
    this.error ??= error;
    this.signal();
  }

  async *entries(): AsyncGenerator<ZipEntry> {
    for (;;) {
      if (this.error) throw this.error;
      const next = this.queue.shift();
      if (next) {
        this.room.shift()?.();
        yield next;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }

  private async push(entry: ZipEntry): Promise<void> {
    if (this.error) throw this.error;
    this.queue.push(entry);
    this.wake?.();
    this.wake = null;
    if (this.queue.length > QUEUE) await new Promise<void>((resolve) => this.room.push(resolve));
    if (this.error) throw this.error;
  }

  private signal(): void {
    this.wake?.();
    this.wake = null;
    for (const r of this.room.splice(0)) r();
  }
}
