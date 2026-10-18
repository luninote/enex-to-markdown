import { type Editor, Node } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { editorLabels } from "../labels.ts";
import { allowRemoteImages, onRemoteAllowed, remoteAllowed } from "../remote.ts";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    image: {
      insertImage: (attrs: {
        src: string;
        alt?: string | null;
        width?: number | null;
        height?: number | null;
      }) => ReturnType;
    };
  }
}

// Images we can show without the user's files: web URLs and inline image data. Relative, file:, cid: and blob:
// sources point at nothing once the note leaves the page they were copied from.
const IMAGE_SRC = /^(?:https?:\/\/|data:image\/[a-z0-9.+-]+[;,])/i;

export function isImageSrc(src: string | null | undefined): src is string {
  return typeof src === "string" && IMAGE_SRC.test(src.trim());
}

function dimension(v: string | null): number | null {
  if (v === null || !/^\s*\d+(?:\.\d+)?\s*(?:px)?\s*$/i.test(v)) return null;
  const n = Math.round(Number.parseFloat(v));
  return n > 0 && n <= 100_000 ? n : null;
}

/**
 * An image referenced by URL (pasted, or from a converted clip). Inline like `attachment`: a "block" image is a
 * paragraph holding only this node. Images stored as resources are `attachment` nodes, not this.
 */
export const Image = Node.create({
  name: "image",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes: () => ({
    src: {
      default: "",
      validate: "string",
      parseHTML: (el: HTMLElement) => (el.getAttribute("src") ?? "").trim(),
    },
    alt: {
      default: null,
      validate: "string|null",
      parseHTML: (el: HTMLElement) => el.getAttribute("alt") || null,
    },
    width: {
      default: null,
      validate: "number|null",
      parseHTML: (el: HTMLElement) => dimension(el.getAttribute("width")),
    },
    height: {
      default: null,
      validate: "number|null",
      parseHTML: (el: HTMLElement) => dimension(el.getAttribute("height")),
    },
  }),

  parseHTML: () => [
    {
      tag: "img[src]",
      getAttrs: (el: HTMLElement) => (isImageSrc(el.getAttribute("src")) ? null : false),
    },
  ],

  renderHTML: ({ HTMLAttributes }) => ["img", { ...HTMLAttributes, referrerpolicy: "no-referrer", loading: "lazy" }],
  renderText: () => "",

  addCommands() {
    return {
      insertImage:
        (attrs) =>
        ({ commands }) =>
          isImageSrc(attrs.src)
            ? commands.insertContent({ type: this.name, attrs: { ...attrs, src: attrs.src.trim() } })
            : false,
    };
  },

  addNodeView() {
    return ({ node, editor }) => new ImageView(node, editor);
  },
});

const isRemote = (src: string) => /^https?:/i.test(src.trim());

function hostOf(src: string): string {
  try {
    return new URL(src).host;
  } catch {
    return "";
  }
}

class ImageView {
  dom: HTMLElement;
  private unsubscribe: (() => void) | null = null;
  private node: PMNode;
  private editor: Editor;

  constructor(node: PMNode, editor: Editor) {
    this.node = node;
    this.editor = editor;
    this.dom = document.createElement("span");
    this.dom.contentEditable = "false";
    this.render();
  }

  private render() {
    const { src, alt, width, height } = this.node.attrs as {
      src: string;
      alt: string | null;
      width: number | null;
      height: number | null;
    };
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.dom.removeAttribute("style");
    this.dom.removeAttribute("title");
    if (isRemote(src) && !remoteAllowed(this.editor)) {
      this.renderPlaceholder(src, alt, width, height);
      this.unsubscribe = onRemoteAllowed(this.editor, () => this.render());
      return;
    }
    this.dom.className = "an-image";
    const img = document.createElement("img");
    img.referrerPolicy = "no-referrer";
    img.decoding = "async";
    img.loading = "lazy";
    img.draggable = false;
    img.alt = alt ?? "";
    if (width) img.width = width;
    if (height) img.height = height;
    img.addEventListener("error", () => {
      this.dom.className = "an-image an-image--broken";
      const label = document.createElement("span");
      label.className = "an-image__label";
      label.textContent = editorLabels().imageUnavailable(alt || null);
      img.replaceWith(label);
    });
    img.src = src;
    this.dom.replaceChildren(img);
  }

  private renderPlaceholder(src: string, alt: string | null, width: number | null, height: number | null) {
    this.dom.className = "an-image an-image--blocked";
    // Keep the shape of a real picture (capped by CSS), so loading doesn't push the text around much. Tiny ones
    // (spacers, tracking pixels) get the compact box instead of a sliver.
    if (width && height && width >= 160 && height >= 60) {
      this.dom.style.width = `${width}px`;
      this.dom.style.aspectRatio = `${width} / ${height}`;
    }
    this.dom.title = src;
    const label = document.createElement("span");
    label.className = "an-image__label";
    label.textContent = alt || editorLabels().remoteImage;
    const host = document.createElement("span");
    host.className = "an-image__host";
    host.textContent = hostOf(src);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "an-image__load";
    button.textContent = editorLabels().loadRemoteImages;
    button.addEventListener("click", () => allowRemoteImages(this.editor));
    this.dom.replaceChildren(label, host, button);
  }

  update(node: PMNode) {
    if (node.type !== this.node.type) return false;
    if (node.attrs === this.node.attrs) return true;
    const changed = ["src", "alt", "width", "height"].some((k) => node.attrs[k] !== this.node.attrs[k]);
    this.node = node;
    if (changed) this.render();
    return true;
  }

  stopEvent(event: Event) {
    return event.target instanceof HTMLButtonElement;
  }

  ignoreMutation() {
    return true;
  }

  destroy() {
    this.unsubscribe?.();
  }
}
