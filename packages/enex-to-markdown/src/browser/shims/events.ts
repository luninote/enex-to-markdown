// node:events and node:stream/promises, for the shared ENEX reader's sinks, which in the browser are MemorySinks.

type Listener = (...args: unknown[]) => void;

export class Emitter {
  private readonly listeners = new Map<string, Listener[]>();

  on(event: string, fn: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), fn]);
    return this;
  }

  once(event: string, fn: Listener): this {
    const wrapped: Listener = (...args) => {
      this.off(event, wrapped);
      fn(...args);
    };
    return this.on(event, wrapped);
  }

  off(event: string, fn: Listener): this {
    this.listeners.set(
      event,
      (this.listeners.get(event) ?? []).filter((l) => l !== fn),
    );
    return this;
  }

  emit(event: string, ...args: unknown[]): boolean {
    const list = this.listeners.get(event) ?? [];
    for (const l of list) l(...args);
    return list.length > 0;
  }
}

export function once(emitter: Emitter, event: string): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    emitter.once(event, (...args) => resolve(args));
    if (event !== "error") emitter.once("error", reject);
  });
}

interface Finishable extends Emitter {
  writableFinished?: boolean;
  destroyed?: boolean;
}

export function finished(stream: Finishable): Promise<void> {
  if (stream.writableFinished || stream.destroyed) return Promise.resolve();
  return new Promise((resolve, reject) => {
    stream.once("finish", () => resolve());
    stream.once("close", () => resolve());
    stream.once("error", reject);
  });
}
