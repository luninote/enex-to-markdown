import { Extension } from "@tiptap/core";
import { Fragment, Slice } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";

/**
 * Pasted HTML longer than this (UTF-16 code units) is not parsed into the document: parsing costs about 200 ms per
 * MB, and 512 K keeps the worst parse near 100 ms.
 */
export const LARGE_PASTE_THRESHOLD = 512 * 1024;

export function isLargePaste(html: string | null | undefined, threshold = LARGE_PASTE_THRESHOLD): boolean {
  return typeof html === "string" && html.length > threshold;
}

export interface LargePasteOptions {
  threshold: number;
  /**
   * Called instead of parsing a paste over the threshold; the paste is then cancelled, and the UI offers
   * `insertWebClip(html)` ("Paste as web clip") or `insertPlainText(text)` ("Paste as plain text").
   * Without a callback, large pastes are parsed like any other.
   */
  onLargePaste: ((html: string, text: string) => void) | null;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    largePaste: {
      /** Inserts text at the selection, one paragraph per line, without parsing it as HTML. */
      insertPlainText: (text: string) => ReturnType;
    };
  }
}

export const LargePaste = Extension.create<LargePasteOptions>({
  name: "largePaste",

  addOptions: () => ({ threshold: LARGE_PASTE_THRESHOLD, onLargePaste: null }),

  addCommands() {
    return {
      insertPlainText:
        (text) =>
        ({ state, tr, dispatch }) => {
          const paragraph = state.schema.nodes.paragraph;
          if (!paragraph) return false;
          const lines = text.replace(/\r\n?/g, "\n").split("\n");
          const blocks = lines.map((line) => paragraph.create(null, line ? state.schema.text(line) : null));
          if (dispatch) tr.replaceSelection(new Slice(Fragment.fromArray(blocks), 1, 1)).scrollIntoView();
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    const options = this.options;
    return [
      new Plugin({
        key: new PluginKey("largePaste"),
        props: {
          handleDOMEvents: {
            // ProseMirror parses the clipboard before `handlePaste` runs; only a DOM handler can skip that parse.
            paste: (view, event) => {
              const onLargePaste = options.onLargePaste;
              const data = event.clipboardData;
              if (!onLargePaste || !view.editable || !data) return false;
              const html = data.getData("text/html");
              if (!isLargePaste(html, options.threshold)) return false;
              event.preventDefault();
              onLargePaste(html, data.getData("text/plain"));
              return true;
            },
          },
        },
      }),
    ];
  },
});
