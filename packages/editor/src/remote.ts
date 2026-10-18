import { type Editor, Extension } from "@tiptap/core";

export interface RemoteContentOptions {
  loadRemoteImages: boolean;
}

export interface RemoteContentStorage {
  allowed: boolean;
  listeners: Set<() => void>;
}

declare module "@tiptap/core" {
  interface Storage {
    remoteContent: RemoteContentStorage;
  }
}

/**
 * Whether this editor may fetch remote images (`image` nodes, clip content). Off by default: imported mail is full of
 * tracking pixels, and opening a note must not tell a third party that it was read. One "Load remote images"
 * click allows it for the whole editor until it is recreated.
 */
export const RemoteContent = Extension.create<RemoteContentOptions, RemoteContentStorage>({
  name: "remoteContent",
  addOptions: () => ({ loadRemoteImages: false }),
  addStorage() {
    return { allowed: this.options.loadRemoteImages, listeners: new Set() };
  },
});

export function remoteAllowed(editor: Editor): boolean {
  return editor.storage.remoteContent?.allowed ?? false;
}

export function allowRemoteImages(editor: Editor): void {
  const s = editor.storage.remoteContent;
  if (!s || s.allowed) return;
  s.allowed = true;
  for (const listener of [...s.listeners]) listener();
}

/** Calls `listener` once remote content is allowed; returns the unsubscribe function. */
export function onRemoteAllowed(editor: Editor, listener: () => void): () => void {
  const s = editor.storage.remoteContent;
  if (!s) return () => {};
  s.listeners.add(listener);
  return () => s.listeners.delete(listener);
}
