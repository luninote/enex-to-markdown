import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { IS_MAC } from "./shortcuts.ts";

export type LinkOpenHandler = (href: string) => void;

/** Whether a click on a link should open it: Ctrl/⌘-click while editing (a plain click places the caret), any click when the note is read-only. */
export function opensLink(
  event: Pick<MouseEvent, "button" | "ctrlKey" | "metaKey">,
  editable: boolean,
  mac = IS_MAC,
): boolean {
  if (event.button !== 0) return false;
  return !editable || (mac ? event.metaKey : event.ctrlKey);
}

/**
 * Hands link clicks to the app, which knows where a link goes (another note, a web page, an Evernote link that
 * wasn't imported). Every click on a link is kept from the browser, so a read-only note never navigates the page.
 */
export const LinkOpen = Extension.create<{ onOpen: LinkOpenHandler | null }>({
  name: "linkOpen",
  addOptions: () => ({ onOpen: null }),
  addProseMirrorPlugins() {
    const options = this.options;
    const editor = this.editor;
    return [
      new Plugin({
        key: new PluginKey("linkOpen"),
        props: {
          handleDOMEvents: {
            click(view, event) {
              const link = (event.target as Element | null)?.closest?.("a[href]");
              if (!link || !view.dom.contains(link)) return false;
              if (!opensLink(event, editor.isEditable)) {
                if (!editor.isEditable) event.preventDefault();
                return false;
              }
              event.preventDefault();
              options.onOpen?.(link.getAttribute("href") ?? "");
              return true;
            },
          },
        },
      }),
    ];
  },
});
