import type { JSONContent } from "@tiptap/core";
import { Node as PMNode } from "@tiptap/pm/model";
import { getEditorSchema } from "./extensions.ts";
import { type FileKind, fileKind } from "./fileKind.ts";
import { htmlToText } from "./htmlText.ts";

export { type FileKind, fileKind };

export type DocInput = JSONContent | PMNode;

function toNode(doc: DocInput): PMNode {
  return doc instanceof PMNode ? doc : getEditorSchema().nodeFromJSON(doc);
}

function inlineText(block: PMNode): string {
  let out = "";
  block.forEach((child) => {
    if (child.isText) out += child.text ?? "";
    else if (child.type.name === "hardBreak") out += "\n";
    else if (child.type.name === "unsupported") out += htmlToText(String(child.attrs.raw ?? ""));
  });
  return out;
}

function blockLines(node: PMNode, lines: string[]): void {
  const name = node.type.name;
  if (name === "webClip") {
    const text = htmlToText(String(node.attrs.html ?? ""));
    if (text) lines.push(text);
    return;
  }
  if (name === "table") {
    node.forEach((row) => {
      const cells: string[] = [];
      row.forEach((cell) => {
        const inner: string[] = [];
        cell.forEach((b) => {
          blockLines(b, inner);
        });
        cells.push(inner.join(" ").replace(/\s+/g, " ").trim());
      });
      lines.push(cells.join("\t"));
    });
    return;
  }
  if (node.isTextblock) {
    lines.push(inlineText(node));
    return;
  }
  node.forEach((child) => {
    blockLines(child, lines);
  });
}

/**
 * Plain text for search and export: one line per text block, table cells tab-separated.
 * Attachments, images and encrypted text contribute nothing (their text is indexed from the resource / never;
 * image alt text is left out like attachment file names).
 */
export function docToPlainText(doc: DocInput): string {
  const lines: string[] = [];
  blockLines(toNode(doc), lines);
  return lines.join("\n");
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** At most `max` user-perceived characters, whitespace collapsed, cut at a word boundary when one is near. */
export function docSnippet(doc: DocInput, max = 200): string {
  const text = docToPlainText(doc).replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  const graphemes: string[] = [];
  for (const { segment } of segmenter.segment(text)) {
    graphemes.push(segment);
    if (graphemes.length > max) break;
  }
  if (graphemes.length <= max) return text;
  const cut = graphemes.slice(0, max).join("");
  // Only back off to a space if the next character continues a word; CJK text has no spaces, so it is cut hard.
  if (graphemes[max] !== " ") {
    const space = cut.lastIndexOf(" ");
    if (space >= cut.length - 30 && space > 0) return cut.slice(0, space).trimEnd();
  }
  return cut.trimEnd();
}

export interface DocFlags {
  /** Plain checkboxes (`contains:enTodo`, `todo:`): task items without a `taskId`. */
  todo: boolean;
  todoChecked: boolean;
  todoUnchecked: boolean;
  /** Evernote Tasks (`contains:task`): task items with a `taskId`. They don't count as checkboxes. */
  task: boolean;
  taskCompleted: boolean;
  taskNotCompleted: boolean;
  list: boolean;
  table: boolean;
  codeBlock: boolean;
  attachment: boolean;
  /** Distinct attachment kinds, for `contains:fileImage` etc. */
  fileKinds: FileKind[];
  /** Distinct attachment MIME types, for `resource:`. */
  mimes: string[];
  webClip: boolean;
  encrypted: boolean;
  url: boolean;
  email: boolean;
}

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']+/i;
const EMAIL_RE = /\b[^\s@<>"']+@[^\s@<>"']+\.[a-z]{2,}\b/i;

export function docFlags(doc: DocInput): DocFlags {
  const f: DocFlags = {
    todo: false,
    todoChecked: false,
    todoUnchecked: false,
    task: false,
    taskCompleted: false,
    taskNotCompleted: false,
    list: false,
    table: false,
    codeBlock: false,
    attachment: false,
    fileKinds: [],
    mimes: [],
    webClip: false,
    encrypted: false,
    url: false,
    email: false,
  };
  const kinds = new Set<FileKind>();
  const mimes = new Set<string>();
  const node = toNode(doc);
  node.descendants((n) => {
    switch (n.type.name) {
      case "taskItem":
        if (n.attrs.taskId) {
          f.task = true;
          if (n.attrs.checked) f.taskCompleted = true;
          else f.taskNotCompleted = true;
        } else {
          f.todo = true;
          if (n.attrs.checked) f.todoChecked = true;
          else f.todoUnchecked = true;
        }
        break;
      case "taskList":
      case "bulletList":
      case "orderedList":
        f.list = true;
        break;
      case "table":
        f.table = true;
        break;
      case "codeBlock":
        f.codeBlock = true;
        break;
      case "attachment":
        f.attachment = true;
        kinds.add(fileKind(n.attrs.mime));
        if (n.attrs.mime) mimes.add(String(n.attrs.mime).toLowerCase());
        break;
      case "webClip":
        f.webClip = true;
        if (/\shref\s*=\s*["']?(?:https?:|www\.)/i.test(String(n.attrs.html ?? ""))) f.url = true;
        return false;
      case "encrypted":
        f.encrypted = true;
        break;
      case "text":
        for (const m of n.marks) {
          if (m.type.name !== "link") continue;
          const href = String(m.attrs.href ?? "");
          if (/^mailto:/i.test(href)) f.email = true;
          else if (href) f.url = true;
        }
        if (!f.url && URL_RE.test(n.text ?? "")) f.url = true;
        if (!f.email && EMAIL_RE.test(n.text ?? "")) f.email = true;
        break;
    }
    return true;
  });
  f.fileKinds = [...kinds].sort();
  f.mimes = [...mimes].sort();
  return f;
}
