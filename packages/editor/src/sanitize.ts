import DOMPurify, { type WindowLike } from "dompurify";
import { CLIP_FIND_CSS } from "./findHighlights.ts";

// Clips are rendered in a sandboxed iframe, but sanitizing is still the first line of defense:
// the iframe is same-origin (needed to measure its height), so nothing executable may reach it.
const CLIP_CONFIG = {
  FORCE_BODY: true,
  WHOLE_DOCUMENT: false,
  ADD_TAGS: ["style"],
  FORBID_TAGS: ["script", "iframe", "frame", "frameset", "object", "embed", "applet", "base", "meta", "link", "portal"],
  FORBID_ATTR: ["srcdoc", "formaction", "ping"],
  ALLOW_UNKNOWN_PROTOCOLS: false,
};

/**
 * Stored with every clip that went through `sanitizeClipHtml` (`webClip.sanitizerVersion`). Bump it whenever
 * CLIP_CONFIG or the DOMPurify version changes, so clips sanitized under the old rules are sanitized again on render.
 */
export const SANITIZER_VERSION = 1;

let browserPurifier: ReturnType<typeof DOMPurify> | null = null;

function purifierFor(win?: WindowLike): ReturnType<typeof DOMPurify> {
  if (win) return DOMPurify(win);
  if (!browserPurifier) {
    if (!DOMPurify.isSupported) throw new Error("sanitizeClipHtml needs a DOM: pass a window (e.g. from jsdom)");
    browserPurifier = DOMPurify;
  }
  return browserPurifier;
}

export function sanitizeClipHtml(html: string, win?: WindowLike): string {
  return purifierFor(win).sanitize(html, CLIP_CONFIG) as string;
}

/** The clip's HTML ready to render: stored HTML sanitized by the current sanitizer is used as is. */
export function cleanClipHtml(html: string, sanitizerVersion: unknown, win?: WindowLike): string {
  return sanitizerVersion === SANITIZER_VERSION ? html : sanitizeClipHtml(html, win);
}

// Opening a note must not contact third-party servers (tracking pixels in old clips): remote loads are opt-in per view.
function clipCsp(allowRemote: boolean): string {
  const remote = allowRemote ? " https: http:" : "";
  return [
    "default-src 'none'",
    `img-src data: blob:${remote}`,
    `media-src data: blob:${remote}`,
    `style-src 'unsafe-inline' data:${remote}`,
    `font-src data:${remote}`,
  ].join("; ");
}

const REMOTE_REF =
  /\b(?:src|srcset|poster|background)\s*=\s*["']?\s*(?:https?:)?\/\/|url\(\s*["']?\s*(?:https?:)?\/\/|@import/i;

/** Whether the clip references anything that would be fetched from the network if allowed. */
export function clipHasRemoteContent(html: string): boolean {
  return REMOTE_REF.test(html);
}

/** Wraps already-sanitized clip HTML into an iframe `srcdoc` document. */
export function clipSrcdoc(sanitizedHtml: string, { allowRemote = false }: { allowRemote?: boolean } = {}): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${clipCsp(allowRemote)}"><base target="_blank"><style>html,body{margin:0}body{padding:8px;overflow-wrap:anywhere}img,svg,video{max-width:100%;height:auto}${CLIP_FIND_CSS}</style></head><body>${sanitizedHtml}</body></html>`;
}
