import type { JSONContent } from "@tiptap/core";
import { DOMParser as PMDOMParser } from "@tiptap/pm/model";
import { getEditorSchema } from "./extensions.ts";
import { isImageSrc } from "./nodes/image.ts";

/** A picture whose bytes are stored as a resource: its `<img>` becomes an `attachment` node. */
export interface HtmlResource {
  resourceId: string;
  mime: string;
  filename?: string | null;
  width?: number | null;
  height?: number | null;
}

export interface HtmlToDocOptions {
  /** Supplies `DOMParser` outside a browser (a jsdom window). Defaults to the global one. */
  window?: { DOMParser: { new (): DOMParser } };
  /** Stored pictures, keyed by the `src` they had in the HTML (after resolving against `baseUrl`). */
  resources?: ReadonlyMap<string, HtmlResource>;
  /** Relative links and image sources are resolved against it; without it they are dropped. */
  baseUrl?: string;
  /** Keep inline `style` (colors, fonts) as text styles. Off by default: a clean, editable note. */
  keepStyles?: boolean;
}

// Content that has no place in an editable note, or whose text would only be noise (an SVG's <title>, a form's
// option list).
const DROP =
  "script,style,noscript,template,svg,math,canvas,iframe,frame,object,embed,video,audio,source,track,map,select,input,textarea,button,dialog,link,meta";

function resolve(url: string | null, base: string | undefined): string | null {
  if (url === null) return null;
  const raw = url.trim();
  if (!raw) return null;
  try {
    return base ? new URL(raw, base).href : new URL(raw).href;
  } catch {
    return null;
  }
}

function attachmentFor(doc: Document, res: HtmlResource, alt: string | null): HTMLElement {
  const span = doc.createElement("span");
  span.setAttribute("data-type", "attachment");
  span.setAttribute("data-resourceId", res.resourceId);
  span.setAttribute("data-display", "inline");
  span.setAttribute("data-mime", res.mime);
  const filename = res.filename ?? alt;
  if (filename) span.setAttribute("data-filename", filename);
  if (res.width) span.setAttribute("data-width", String(res.width));
  if (res.height) span.setAttribute("data-height", String(res.height));
  return span;
}

/**
 * Turns an HTML fragment (a clipped selection, a simplified article) into a document of the editor's schema.
 * Stored pictures become `attachment` nodes, other web pictures `image` nodes, and everything the schema can't
 * hold is dropped or reduced to its text. The result still has to pass `checkDoc` before it's saved.
 */
export function htmlToDoc(html: string, options: HtmlToDocOptions = {}): JSONContent {
  const Parser = options.window?.DOMParser ?? globalThis.DOMParser;
  if (!Parser) throw new Error("htmlToDoc needs a DOM: pass a window (e.g. from jsdom)");
  const doc = new Parser().parseFromString(`<!doctype html><html><body>${html}</body></html>`, "text/html");
  const body = doc.body;

  for (const el of Array.from(body.querySelectorAll(DROP))) el.remove();
  if (!options.keepStyles) {
    for (const el of Array.from(body.querySelectorAll("[style]"))) {
      // Paragraph alignment and indent are formatting the schema keeps (v3); colors and fonts are the page's look.
      const block = /^(P|H[1-6])$/.test(el.tagName) ? (el as HTMLElement).style : null;
      const align = block?.textAlign ?? "";
      const indent = block?.marginLeft || block?.paddingLeft || "";
      el.removeAttribute("style");
      if (align) (el as HTMLElement).style.textAlign = align;
      if (indent) (el as HTMLElement).style.marginLeft = indent;
    }
    for (const el of Array.from(body.querySelectorAll("font"))) el.replaceWith(...Array.from(el.childNodes));
  }

  for (const a of Array.from(body.querySelectorAll("a[href]"))) {
    const href = a.getAttribute("href") ?? "";
    // In-page anchors point nowhere once the text leaves the page.
    const abs = href.startsWith("#") ? null : resolve(href, options.baseUrl);
    if (abs) a.setAttribute("href", abs);
    else a.removeAttribute("href");
  }

  for (const img of Array.from(body.querySelectorAll("img"))) {
    const src = resolve(img.getAttribute("src"), options.baseUrl) ?? img.getAttribute("src");
    const res = src ? options.resources?.get(src) : undefined;
    if (res) {
      img.replaceWith(attachmentFor(doc, res, img.getAttribute("alt")));
    } else if (src && isImageSrc(src)) {
      img.setAttribute("src", src);
    } else {
      img.remove();
    }
  }

  const node = PMDOMParser.fromSchema(getEditorSchema()).parse(body);
  const json = node.toJSON() as JSONContent;
  // A fragment with no blocks parses as an empty doc, which the schema (block+) rejects.
  if (!json.content?.length) json.content = [{ type: "paragraph" }];
  return json;
}
