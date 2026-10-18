import { Node } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { type FileKind, fileKind, fileKindLabel, isDisplayableImage } from "../fileKind.ts";
import { editorLabels } from "../labels.ts";
import type { EditorResources } from "../resources.ts";

type AttrSpec = { default: string | number | null; kind?: "string" | "number" };

// Atom attrs round-trip through `data-*` attributes so copy/paste between notes keeps them.
function dataAttributes(spec: Record<string, AttrSpec>) {
  return Object.fromEntries(
    Object.entries(spec).map(([name, { default: def, kind = "string" }]) => {
      const dataName = `data-${name.replaceAll("_", "-")}`;
      return [
        name,
        {
          default: def,
          // null leaves the value to the parse rule's own attrs, then to the schema default.
          parseHTML: (el: HTMLElement) => {
            const v = el.getAttribute(dataName);
            if (v === null) return null;
            if (kind === "number") {
              const n = Number(v);
              return Number.isFinite(n) ? n : null;
            }
            return v;
          },
          renderHTML: (attrs: Record<string, unknown>) =>
            attrs[name] === null || attrs[name] === undefined ? {} : { [dataName]: String(attrs[name]) },
        },
      ];
    }),
  );
}

function pixels(v: string | null): number | null {
  const n = v === null ? Number.NaN : Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function chip(className: string, label: string, title?: string): HTMLElement {
  const dom = document.createElement("span");
  dom.className = `an-chip ${className}`;
  dom.contentEditable = "false";
  dom.textContent = label;
  if (title) dom.title = title;
  return dom;
}

const ATTACHMENT_ATTRS: Record<string, AttrSpec> = {
  resourceId: { default: null },
  display: { default: "inline" },
  mime: { default: null },
  filename: { default: null },
  width: { default: null, kind: "number" },
  height: { default: null, kind: "number" },
};

export interface AttachmentOptions {
  resources: EditorResources | null;
}

export const Attachment = Node.create<AttachmentOptions>({
  name: "attachment",
  addOptions: () => ({ resources: null }),
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes: () => dataAttributes(ATTACHMENT_ATTRS),
  parseHTML: () => [
    { tag: 'span[data-type="attachment"]' },
    // Resource placeholders in imported web clips, so "Convert to editable" keeps their images and files.
    {
      tag: "img[data-resource-id]",
      priority: 60,
      getAttrs: (el: HTMLElement) => ({
        resourceId: el.getAttribute("data-resource-id"),
        display: "inline",
        filename: el.getAttribute("alt") || null,
        width: pixels(el.getAttribute("width")),
        height: pixels(el.getAttribute("height")),
      }),
    },
    {
      tag: "span[data-resource-id]",
      getAttrs: (el: HTMLElement) => {
        const label = (el.textContent ?? "").replace(/^\[(.*)\]$/s, "$1").trim();
        return {
          resourceId: el.getAttribute("data-resource-id"),
          display: "card",
          filename: label && label !== el.getAttribute("data-mime") ? label : null,
        };
      },
    },
  ],
  renderHTML({ node, HTMLAttributes }) {
    return ["span", { ...HTMLAttributes, "data-type": "attachment" }, String(node.attrs.filename ?? "attachment")];
  },
  renderText: ({ node }) => (node.attrs.filename ? `[${node.attrs.filename}]` : ""),
  addNodeView() {
    const resources = this.options.resources;
    return ({ node }) => ({
      dom: renderAttachment(node, resources),
      // Any attribute change redraws the view (returning false makes ProseMirror create a new one).
      update: (next) => next.type === node.type && sameAttrs(next.attrs, node.attrs),
      ignoreMutation: () => true,
    });
  },
});

function sameAttrs(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return Object.keys(ATTACHMENT_ATTRS).every((k) => a[k] === b[k]);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

const IMAGE_RETRIES_MS = [1_000, 3_000, 8_000];

const KIND_BADGE: Partial<Record<FileKind, string>> = {
  image: "IMG",
  pdf: "PDF",
  audio: "AUD",
  video: "VID",
  archive: "ZIP",
};

/** A short type label for the card's icon: the file extension when it has a sensible one, else the kind. */
export function fileBadge(filename: string | null | undefined, kind: FileKind): string {
  const ext = /\.([a-z0-9]{1,4})$/i.exec(filename ?? "")?.[1];
  return ext ? ext.toUpperCase() : (KIND_BADGE[kind] ?? "FILE");
}

function renderAttachment(node: PMNode, resources: EditorResources | null): HTMLElement {
  const { resourceId, display, filename, mime, width, height } = node.attrs as {
    resourceId: string | null;
    display: string;
    filename: string | null;
    mime: string | null;
    width: number | null;
    height: number | null;
  };
  const url = resources && resourceId ? resources.url(resourceId) : null;
  const dom = el("span", "an-attachment");
  dom.contentEditable = "false";
  if (!(url && display !== "card" && isDisplayableImage(mime))) {
    dom.classList.add("an-attachment--card");
    dom.append(card(url, filename, mime));
    return dom;
  }
  dom.classList.add("an-attachment--image");
  const img = document.createElement("img");
  img.alt = filename ?? "";
  img.decoding = "async";
  img.loading = "lazy";
  img.draggable = false;
  if (width) img.width = width;
  if (height) img.height = height;
  // A just-attached file is shown before its attachment record reaches the server, so the first requests can fail;
  // retry a few times before showing the image as broken.
  let attempt = 0;
  img.addEventListener("error", () => {
    if (attempt < IMAGE_RETRIES_MS.length && img.isConnected) {
      const wait = IMAGE_RETRIES_MS[attempt++];
      setTimeout(() => {
        img.src = `${url}${url.includes("?") ? "&" : "?"}retry=${attempt}`;
      }, wait);
      return;
    }
    dom.className = "an-attachment an-attachment--card an-attachment--broken";
    img.replaceWith(card(url, filename, mime, editorLabels().imageFailed));
  });
  img.src = url;
  dom.append(img);
  return dom;
}

function card(url: string | null, filename: string | null, mime: string | null, note?: string): HTMLElement {
  const kind = fileKind(mime);
  const body = url ? el("a", "an-attachment__card") : el("span", "an-attachment__card");
  body.dataset.kind = kind;
  if (body instanceof HTMLAnchorElement && url) {
    body.href = url;
    body.target = "_blank";
    body.rel = "noopener noreferrer";
    body.title = editorLabels().openInNewTab(filename);
  }
  const icon = el("span", "an-attachment__icon", fileBadge(filename, kind));
  icon.setAttribute("aria-hidden", "true");
  const text = el("span", "an-attachment__text");
  text.append(
    el("span", "an-attachment__name", filename ?? editorLabels().untitledAttachment),
    el("span", "an-attachment__meta", note ?? (mime ? `${fileKindLabel(kind)} · ${mime}` : fileKindLabel(kind))),
  );
  body.append(icon, text);
  return body;
}

export const Encrypted = Node.create({
  name: "encrypted",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: () =>
    dataAttributes({
      // ENML DTD defaults for en-crypt.
      cipher: { default: "RC2" },
      length: { default: 64, kind: "number" },
      hint: { default: null },
      ciphertext: { default: "" },
    }),
  parseHTML: () => [{ tag: 'span[data-type="encrypted"]' }],
  renderHTML: ({ HTMLAttributes }) => [
    "span",
    { ...HTMLAttributes, "data-type": "encrypted" },
    editorLabels().encrypted,
  ],
  renderText: () => "",
  addNodeView() {
    return ({ node }) => {
      const hint = node.attrs.hint as string | null;
      const dom = chip(
        "an-chip--encrypted",
        editorLabels().encrypted,
        hint ? editorLabels().encryptedHint(hint) : undefined,
      );
      return { dom, ignoreMutation: () => true };
    };
  },
});

export const Unsupported = Node.create({
  name: "unsupported",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: () => dataAttributes({ raw: { default: "" } }),
  parseHTML: () => [{ tag: 'span[data-type="unsupported"]' }],
  renderHTML: ({ HTMLAttributes }) => [
    "span",
    { ...HTMLAttributes, "data-type": "unsupported" },
    editorLabels().unsupported,
  ],
  renderText: () => "",
  addNodeView() {
    return ({ node }) => {
      const raw = String(node.attrs.raw ?? "");
      const dom = chip("an-chip--unsupported", editorLabels().unsupportedKept, raw.slice(0, 500));
      return { dom, ignoreMutation: () => true };
    };
  },
});
