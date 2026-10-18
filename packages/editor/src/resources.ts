import { cleanClipHtml } from "./sanitize.ts";
export interface EditorResources {
  /** A URL the browser loads directly (`<img src>`, a link). The API checks the session and redirects to the bytes. */
  url(resourceId: string): string;
  /**
   * A `blob:` URL holding the resource's bytes, for images inside web clips: the clip's CSP allows `blob:` but not
   * our origin. Every call must return a new URL owned by the caller, which revokes it when the clip view goes away.
   */
  fetchBlobUrl?(resourceId: string): Promise<string>;
}

// Clip HTML is always the serialized output of DOMPurify (or the import's sanitizer), so attributes are
// double-quoted with `"` escaped as &quot;, which keeps these patterns exact.
const RESOURCE_IMG = /<img\b[^>]*?\sdata-resource-id="([^"]*)"[^>]*>/gi;
const SRC_ATTR = /\ssrc="[^"]*"/gi;

const decode = (v: string) =>
  v
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
const encode = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

/** Distinct resource ids of the `<img data-resource-id>` placeholders in clip HTML, in document order. */
export function clipResourceIds(html: string): string[] {
  if (!html.includes("data-resource-id")) return [];
  const ids = new Set<string>();
  for (const m of html.matchAll(RESOURCE_IMG)) {
    const id = decode(m[1] ?? "");
    if (id) ids.add(id);
  }
  return [...ids];
}

/**
 * Every attachment a document shows, found exactly as the editor renders it: attachment nodes' `resourceId`, and
 * clip images through `cleanClipHtml` + `clipResourceIds`, the same steps the clip view takes. Outside a browser,
 * pass a `clean` that sanitizes with a window (jsdom). Text that merely mentions an id doesn't count.
 */
export function docResourceIds(
  doc: unknown,
  // The clip view renders String(html), whatever was stored; so must this.
  clean: (html: unknown, sanitizerVersion: unknown) => string = (html, v) => cleanClipHtml(String(html ?? ""), v),
): string[] {
  const found = new Set<string>();
  // Iterative: deeply nested blocks must not hide an attachment.
  const stack: unknown[] = [doc];
  while (stack.length) {
    const v = stack.pop();
    if (Array.isArray(v)) {
      for (const x of v) stack.push(x);
      continue;
    }
    if (!v || typeof v !== "object") continue;
    const node = v as { type?: unknown; attrs?: Record<string, unknown>; content?: unknown };
    const attrs = node.attrs ?? {};
    if (node.type === "attachment" && typeof attrs.resourceId === "string" && attrs.resourceId)
      found.add(attrs.resourceId);
    if (node.type === "webClip")
      for (const id of clipResourceIds(clean(attrs.html, attrs.sanitizerVersion))) found.add(id);
    if (node.content !== undefined) stack.push(node.content);
  }
  return [...found];
}

/**
 * Points each `<img data-resource-id>` placeholder at `srcFor(id)`, replacing any `src` it had. Placeholders
 * without a source are left without one, so the browser shows their alt text instead of fetching anything.
 */
export function setClipResourceSrcs(html: string, srcFor: (resourceId: string) => string | null | undefined): string {
  if (!html.includes("data-resource-id")) return html;
  return html.replace(RESOURCE_IMG, (tag, rawId: string) => {
    const src = srcFor(decode(rawId));
    const bare = tag.replace(SRC_ATTR, "");
    return src ? bare.replace(/^<img\b/i, `<img src="${encode(src)}"`) : bare;
  });
}
