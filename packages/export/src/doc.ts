import { NOTE_LINK_PREFIX } from "@luninote/enml";

/** A stored document node (ProseMirror JSON, `packages/editor` schema), read without the editor. */
export type DocMark = { type: string; attrs?: Record<string, unknown> };
export type DocNode = {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: DocMark[];
  content?: DocNode[];
};

export const attr = <T = unknown>(n: { attrs?: Record<string, unknown> }, name: string): T | null =>
  (n.attrs?.[name] ?? null) as T | null;

export const str = (n: { attrs?: Record<string, unknown> }, name: string): string | null => {
  const v = n.attrs?.[name];
  return typeof v === "string" ? v : null;
};

export const num = (n: { attrs?: Record<string, unknown> }, name: string): number | null => {
  const v = n.attrs?.[name];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};

// The editor's schema order: marks nest in this order, outermost first, wherever a document is written out.
export const MARK_ORDER = [
  "link",
  "textStyle",
  "bold",
  "code",
  "italic",
  "strike",
  "underline",
  "highlight",
  "subscript",
  "superscript",
];

/** Schema v3 block formatting as CSS: alignment, and indent as Evernote's 40px steps. Empty when there is none. */
export function blockCss(n: { attrs?: Record<string, unknown> }, indentUnit = "px"): string {
  const parts: string[] = [];
  const align = n.attrs?.textAlign;
  if (align === "center" || align === "right" || align === "justify") parts.push(`text-align:${align}`);
  const indent = n.attrs?.indent;
  if (typeof indent === "number" && Number.isInteger(indent) && indent > 0)
    parts.push(
      indentUnit === "px" ? `padding-left:${Math.min(indent, 8) * 40}px` : `margin-left:${Math.min(indent, 8) * 2}em`,
    );
  return parts.join(";");
}

export function sortedMarks(marks: DocMark[] | undefined): DocMark[] {
  if (!marks?.length) return [];
  return [...marks].sort((a, b) => rank(a.type) - rank(b.type));
}

const rank = (t: string) => {
  const i = MARK_ORDER.indexOf(t);
  return i < 0 ? MARK_ORDER.length : i;
};

export function sameMark(a: DocMark, b: DocMark): boolean {
  if (a.type !== b.type) return false;
  const ka = Object.entries(a.attrs ?? {}).filter(([, v]) => v !== null && v !== undefined);
  const kb = Object.entries(b.attrs ?? {}).filter(([, v]) => v !== null && v !== undefined);
  return ka.length === kb.length && ka.every(([k, v]) => b.attrs?.[k] === v);
}

/** The note id of one of our own note links (`/note/<id>`), or null for any other href. */
export function noteLinkTarget(href: string): string | null {
  if (!href.startsWith(NOTE_LINK_PREFIX)) return null;
  const id = href.slice(NOTE_LINK_PREFIX.length).split(/[?#/]/)[0] ?? "";
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id.toLowerCase() : null;
}

/** Plain text of a node's inline content (marks ignored, hard breaks as newlines). */
export function inlineText(node: DocNode): string {
  let out = "";
  for (const c of node.content ?? []) {
    if (c.type === "text") out += c.text ?? "";
    else if (c.type === "hardBreak") out += "\n";
    else if (c.content) out += inlineText(c);
  }
  return out;
}

/** Every resource id the document's attachment nodes show, in order, once each (web clips not included). */
export function attachmentIds(doc: DocNode): string[] {
  const out = new Set<string>();
  const stack: DocNode[] = [doc];
  while (stack.length) {
    const n = stack.pop() as DocNode;
    if (n.type === "attachment") {
      const id = str(n, "resourceId");
      if (id) out.add(id);
    }
    if (n.content) for (let i = n.content.length - 1; i >= 0; i--) stack.push(n.content[i] as DocNode);
  }
  return [...out];
}

const CLIP_NOTE_HREF = /href\s*=\s*["']?\/note\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;

/** Ids of our notes the document links to (`/note/<id>` hrefs), web clips included. */
export function linkedNoteIds(doc: DocNode): string[] {
  const out = new Set<string>();
  const stack: DocNode[] = [doc];
  while (stack.length) {
    const n = stack.pop() as DocNode;
    if (n.type === "webClip")
      for (const m of String(n.attrs?.html ?? "").matchAll(CLIP_NOTE_HREF)) out.add((m[1] as string).toLowerCase());
    for (const m of n.marks ?? []) {
      if (m.type !== "link") continue;
      const id = noteLinkTarget(String(m.attrs?.href ?? ""));
      if (id) out.add(id);
    }
    if (n.content) for (const c of n.content) stack.push(c);
  }
  return [...out];
}
