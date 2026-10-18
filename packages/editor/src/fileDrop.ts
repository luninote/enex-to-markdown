import { type Editor, Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

export type FilesHandler = (files: File[], pos: number | null, editor: Editor) => void;

export interface FileDropOptions {
  /** Files dropped or pasted into the editor. The editor inserts nothing itself; `pos` is null for a paste. */
  onFiles: FilesHandler | null;
}

/**
 * Whether a clipboard or drag payload should be taken as files. Copying an image in a browser puts both the file and a
 * bare `<img>` in HTML on the clipboard; the file is what the user means. HTML with any text (a copied page, a Word
 * paragraph with a picture) stays with the normal HTML paste.
 */
export function payloadFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files = Array.from(data.files ?? []);
  if (!files.length) return [];
  const html = data.getData("text/html");
  if (html && htmlHasText(html)) return [];
  return files;
}

function htmlHasText(html: string): boolean {
  if (typeof DOMParser === "undefined") return /[^\s]/.test(html.replace(/<[^>]*>/g, ""));
  const body = new DOMParser().parseFromString(html, "text/html").body;
  return /\S/.test(body?.textContent ?? "");
}

export const FileDrop = Extension.create<FileDropOptions>({
  name: "fileDrop",
  addOptions: () => ({ onFiles: null }),

  addProseMirrorPlugins() {
    const options = this.options;
    const editor = this.editor;
    return [
      new Plugin({
        key: new PluginKey("fileDrop"),
        props: {
          handleDrop: (view, event, _slice, moved) => {
            if (moved || !options.onFiles || !view.editable) return false;
            const files = payloadFiles(event.dataTransfer);
            if (!files.length) return false;
            event.preventDefault();
            const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? null;
            options.onFiles(files, pos, editor);
            return true;
          },
          handlePaste: (view, event) => {
            if (!options.onFiles || !view.editable) return false;
            const files = payloadFiles(event.clipboardData);
            if (!files.length) return false;
            event.preventDefault();
            options.onFiles(files, null, editor);
            return true;
          },
        },
      }),
    ];
  },
});
