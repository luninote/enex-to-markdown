import { type DocNode, noteLinkTarget } from "./doc.ts";
import { parseFragment, toXml, type XmlRewrite } from "./markup.ts";

/** What the HTML and Markdown writers need to know about the archive they write into. */
export interface RenderContext {
  /** Where an attachment's bytes are, relative to the file being written; null when the archive has no copy. */
  attachment(resourceId: string): { href: string; mime: string | null; filename: string | null } | null;
  /** A relative link to another exported note's file, or null when that note isn't in the archive. */
  noteLink(noteId: string): string | null;
  /** Web clip HTML as the viewer would show it (sanitized). Defaults to the stored HTML. */
  cleanClip?(html: string, sanitizerVersion: unknown): string;
  /**
   * Whether a URL may stay in what's written (default: every safe scheme). Applied to links in the note and to every
   * URL attribute in a clip, after its pictures were pointed at their files.
   */
  allowUrl?(href: string): boolean;
  /**
   * A clip element other than a picture that names an attachment becomes a link to its file (default). False: only
   * clip pictures, as the editor shows them, ever reach a file.
   */
  clipFileLinks?: boolean;
  /** Markdown only. False: text colors and fonts are left out instead of written as inline HTML (default: kept). */
  textStyles?: boolean;
  /** Markdown only. "equals": highlights as `==text==` (Obsidian) instead of `<mark>`. */
  highlight?: "html" | "equals";
  /**
   * Markdown only. Links to notes become `[[target|text]]` and attachments `![[path]]` (Obsidian). Each function gives
   * the name or path to put between the brackets, or null to fall back to a relative Markdown link.
   */
  wikiLinks?: {
    note(noteId: string): string | null;
    attachment(resourceId: string): string | null;
  };
  /**
   * Markdown only. What follows a task item's text, leading space included ("" for nothing). Null keeps the default
   * `*(due …, flagged)*`.
   */
  taskSuffix?(item: DocNode): string | null;
  /** Markdown only. Also escape `$` (math in some editors) and `==` (highlight) in text. */
  escapeExtra?: boolean;
}

const SAFE_SCHEME = /^(https?|mailto|tel|ftp|evernote):/i;

export type LinkTarget = { kind: "url"; href: string } | { kind: "note"; href: string } | { kind: "none" };

/** Where a link in a note should point in a standalone file. Scripts and unknown schemes don't become links. */
export function linkTarget(raw: string, ctx: RenderContext): LinkTarget {
  const href = raw.trim();
  const note = noteLinkTarget(href);
  if (note) {
    const rel = ctx.noteLink(note);
    return rel ? { kind: "note", href: rel } : { kind: "none" };
  }
  if ((SAFE_SCHEME.test(href) || /^#/.test(href)) && (ctx.allowUrl?.(href) ?? true)) return { kind: "url", href };
  return { kind: "none" };
}

const COLOR = /^(#[0-9a-f]{3,8}|[a-z]+|(rgb|rgba|hsl|hsla)\([\d\s.,%/]+\))$/i;
const SIZE = /^(\d+(\.\d+)?(px|pt|em|rem|%)|xx-small|x-small|small|medium|large|x-large|xx-large|smaller|larger)$/i;

export const cssColor = (v: unknown): string | null =>
  typeof v === "string" && COLOR.test(v.trim()) ? v.trim() : null;
export const cssSize = (v: unknown): string | null => (typeof v === "string" && SIZE.test(v.trim()) ? v.trim() : null);
export const cssFamily = (v: unknown): string | null =>
  typeof v === "string" && v.length <= 200 && !/[;{}<>\\]|url\(|expression\(/i.test(v) ? v.trim() : null;

/** The inline style a textStyle mark stands for, or "" when none of its values is safe to write. */
export function textStyleCss(attrs: Record<string, unknown> | undefined): string {
  const a = attrs ?? {};
  const parts: string[] = [];
  const color = cssColor(a.color);
  const family = cssFamily(a.fontFamily);
  const size = cssSize(a.fontSize);
  if (color) parts.push(`color:${color}`);
  if (family) parts.push(`font-family:${family}`);
  if (size) parts.push(`font-size:${size}`);
  return parts.join(";");
}

// Attributes that hold a URL. Each goes through the same policy, whichever element carries it.
const URL_ATTRS = new Set([
  "href",
  "xlink:href",
  "src",
  "srcset",
  "action",
  "formaction",
  "poster",
  "background",
  "cite",
  "longdesc",
  "usemap",
  "data",
  "ping",
  "lowsrc",
  "dynsrc",
]);

// Never anything that runs or loads another document, even from a clip the viewer's sanitizer already passed.
const ACTIVE = new Set(
  "script noscript iframe frame frameset object embed applet base meta link template portal".split(" "),
);
const UNSAFE_URL = /^\s*(javascript|vbscript|data:text\/html)/i;

/** A web clip's HTML for a file in the archive: its images point at the attachment files, links at note files. */
export function clipForFile(n: DocNode, ctx: RenderContext, dropStyles: boolean): string {
  const stored = String(n.attrs?.html ?? "");
  const html = ctx.cleanClip ? ctx.cleanClip(stored, n.attrs?.sanitizerVersion ?? null) : stored;
  const rewrite: XmlRewrite = (el) => {
    if (ACTIVE.has(el.name) || (dropStyles && el.name === "style")) return "drop";
    const attribs: Record<string, string> = {};
    for (const [k, v] of Object.entries(el.attribs)) {
      if (/^on/i.test(k) || k === "srcdoc" || k === "formaction") continue;
      if ((k === "href" || k === "src" || k === "action") && UNSAFE_URL.test(v)) continue;
      attribs[k] = v;
    }
    let name = el.name;
    const resourceId = attribs["data-resource-id"];
    if (resourceId !== undefined) {
      delete attribs["data-resource-id"];
      const a = name === "img" || ctx.clipFileLinks !== false ? ctx.attachment(resourceId) : null;
      if (name === "img") {
        if (a) attribs.src = a.href;
      } else if (a) {
        for (const k of Object.keys(attribs)) delete attribs[k];
        name = "a";
        attribs.href = a.href;
      }
    }
    if (name === "a" && attribs.href !== undefined) {
      const t = linkTarget(attribs.href, ctx);
      if (t.kind === "none") delete attribs.href;
      else attribs.href = t.href;
    }
    for (const [k, v] of Object.entries(attribs)) {
      const key = k.toLowerCase();
      if (URL_ATTRS.has(key) && !urlKept(key === "srcset" ? srcsetUrls(v) : [v], ctx)) delete attribs[k];
    }
    return { name, attribs };
  };
  return toXml(parseFragment(html), rewrite);
}

const srcsetUrls = (value: string) => value.split(",").map((part) => part.trim().split(/\s+/)[0] ?? "");

/** Each URL is a note we write out, or one `allowUrl` keeps. */
function urlKept(urls: string[], ctx: RenderContext): boolean {
  return urls.every((raw) => {
    const u = raw.trim();
    const note = noteLinkTarget(u);
    if (note) return ctx.noteLink(note) !== null;
    return ctx.allowUrl?.(u) ?? true;
  });
}

export const isImage = (mime: string | null | undefined) =>
  /^image\/(png|jpe?g|gif|webp|svg\+xml|bmp|avif|x-icon)$/i.test(mime ?? "");
