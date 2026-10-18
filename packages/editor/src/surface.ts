import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export interface SurfaceOptions {
  placeholder: string | null;
}

/** Marks the editor element for the app's content styles (`.an-doc`) and shows the placeholder in an empty note. */
export const Surface = Extension.create<SurfaceOptions>({
  name: "surface",
  addOptions: () => ({ placeholder: null }),

  addProseMirrorPlugins() {
    const text = this.options.placeholder;
    return [
      new Plugin({
        key: new PluginKey("surface"),
        props: {
          attributes: { class: "an-doc" },
          decorations: (state) => {
            const { doc } = state;
            const first = doc.firstChild;
            if (!text || doc.childCount !== 1 || !first?.isTextblock || first.content.size) return null;
            return DecorationSet.create(doc, [
              Decoration.node(0, first.nodeSize, { class: "an-placeholder", "data-placeholder": text }),
            ]);
          },
        },
      }),
    ];
  },
});
