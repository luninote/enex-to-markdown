import { DEFAULT_CLIP_THRESHOLDS, measureClip, shouldPreserveAsClip } from "@luninote/enml";
import { clipToEnml } from "./clip.ts";
import { blockCss, type DocMark, type DocNode, inlineText, noteLinkTarget, num, sortedMarks, str } from "./doc.ts";
import { parseFragment, toXml } from "./markup.ts";
import { escapeAttr, escapeText } from "./xml.ts";

// Our document → ENML: the inverse of `packages/enml`'s converter, written so that converting the result again gives
// the same document (tested over every fixture). Where Evernote has its own notation (checklists, code blocks,
// highlights, Evernote Tasks), it's used, so Evernote and other ENEX readers show the note as intended.

export const ENML_HEADER =
  '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n<!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd">\n';

export interface EnmlResource {
  md5: string;
  mime: string;
}

export interface EnmlContext {
  /** The bytes behind an attachment: its MD5 (what `<en-media hash>` names) and MIME type. Null when unknown. */
  resource(resourceId: string): EnmlResource | null;
  /** The href to write for a link to one of our notes. Null (or no function) keeps `/note/<id>`. */
  noteLink?(noteId: string): string | null;
  /** Web clip HTML as the viewer would show it (sanitized). Defaults to the stored HTML. */
  cleanClip?(html: string, sanitizerVersion: unknown): string;
  /** Ids for task groups; defaults to fixed UUID-shaped ids numbered within the note. */
  groupId?(index: number): string;
}

/** An Evernote Task (ENEX `<task>`), for the note's `<task>` elements next to its ENML. */
export interface EnmlTask {
  id: string;
  title: string;
  status: "open" | "completed";
  flag: boolean;
  sortWeight: string;
  groupId: string;
  /** ISO 8601. */
  dueDate: string | null;
}

export interface EnmlResult {
  enml: string;
  tasks: EnmlTask[];
  /** Attachments the ENML shows (`<en-media>`), in order, once each: the note's `<resource>`s. */
  resourceIds: string[];
  /** What couldn't be written: `code: detail` lines for the export report. */
  warnings: string[];
}

const HIGHLIGHT_NAMES: [string, number][] = [
  ["red", 0],
  ["orange", 30],
  ["yellow", 55],
  ["green", 120],
  ["blue", 210],
  ["purple", 280],
  ["pink", 330],
];

function highlightName(color: string): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/.exec(color);
  if (!m) return "yellow";
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => Number.parseInt(h as string, 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 0.04) return "yellow";
  let hue: number;
  if (max === r) hue = ((g - b) / (max - min)) * 60;
  else if (max === g) hue = ((b - r) / (max - min) + 2) * 60;
  else hue = ((r - g) / (max - min) + 4) * 60;
  hue = (hue + 360) % 360;
  let best = "yellow";
  let dist = 999;
  for (const [name, h] of HIGHLIGHT_NAMES) {
    const d = Math.min(Math.abs(hue - h), 360 - Math.abs(hue - h));
    if (d < dist) {
      dist = d;
      best = name;
    }
  }
  return best;
}

const defaultGroupId = (i: number) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`;

// Text the converter would collapse or trim: kept by a `white-space: pre-wrap` span, which it reads verbatim.
const NEEDS_PRE = /^ | $| {2}|[\t\n\r\f]/;

export function docToEnml(doc: DocNode, ctx: EnmlContext): EnmlResult {
  const w = new EnmlWriter(ctx);
  const blocks = doc.content ?? [];
  let body: string;
  if (blocks.length === 1 && blocks[0]?.type === "webClip") body = w.soleClip(blocks[0]);
  else body = blocks.map((b) => w.block(b)).join("");
  return {
    enml: `${ENML_HEADER}<en-note>${body}</en-note>`,
    tasks: w.tasks,
    resourceIds: w.resourceIds,
    warnings: w.warnings,
  };
}

class EnmlWriter {
  tasks: EnmlTask[] = [];
  resourceIds: string[] = [];
  warnings: string[] = [];
  private groups = 0;

  private readonly ctx: EnmlContext;

  constructor(ctx: EnmlContext) {
    this.ctx = ctx;
  }

  private warn(code: string, detail: string) {
    if (this.warnings.length < 50) this.warnings.push(`${code}: ${detail}`);
  }

  block(n: DocNode): string {
    switch (n.type) {
      case "paragraph": {
        const css = blockCss(n);
        return `<div${css ? ` style="${css}"` : ""}>${this.lines(n)}</div>`;
      }
      case "heading": {
        const level = Math.min(6, Math.max(1, num(n, "level") ?? 1));
        const css = blockCss(n);
        return `<h${level}${css ? ` style="${css}"` : ""}>${this.lines(n)}</h${level}>`;
      }
      case "blockquote":
        return `<blockquote>${this.blocks(n)}</blockquote>`;
      case "horizontalRule":
        return "<hr/>";
      case "bulletList":
        return `<ul>${(n.content ?? []).map((li) => `<li>${this.blocks(li)}</li>`).join("")}</ul>`;
      case "orderedList": {
        const start = num(n, "start");
        const type = str(n, "type");
        const attrs = `${start !== null && start !== 1 ? ` start="${start}"` : ""}${type ? ` type="${escapeAttr(type)}"` : ""}`;
        return `<ol${attrs}>${(n.content ?? []).map((li) => `<li>${this.blocks(li)}</li>`).join("")}</ol>`;
      }
      case "taskList":
        return this.taskList(n);
      case "codeBlock":
        return this.codeBlock(n);
      case "table":
        return this.table(n);
      case "webClip":
        return this.clip(n);
      default:
        // An unknown block (a newer schema): its text, so nothing readable is lost.
        this.warn("unknown_block", n.type);
        return n.content ? `<div>${escapeText(inlineText(n))}</div>` : "";
    }
  }

  private blocks(n: DocNode): string {
    const content = n.content ?? [];
    return content.length ? content.map((b) => this.block(b)).join("") : "<div><br/></div>";
  }

  /** Inline content of a text block. A trailing `<br/>` ends a line instead of opening one, so add one more. */
  private lines(n: DocNode): string {
    const content = n.content ?? [];
    const last = content[content.length - 1];
    const inner = this.inline(content);
    return !last || last.type === "hardBreak" ? `${inner}<br/>` : inner;
  }

  private inline(nodes: DocNode[]): string {
    const out: string[] = [];
    let open: DocMark[] = [];
    const close = (keep: number) => {
      while (open.length > keep) out.push(closeTag(open.pop() as DocMark));
    };
    for (const n of nodes) {
      const marks = n.type === "hardBreak" ? [] : sortedMarks(n.marks);
      let common = 0;
      while (common < open.length && common < marks.length && sameMarkAttrs(open[common], marks[common])) common++;
      close(common);
      for (let i = common; i < marks.length; i++) {
        const m = marks[i] as DocMark;
        out.push(this.openTag(m));
        open.push(m);
      }
      out.push(this.atom(n));
    }
    close(0);
    open = [];
    return out.join("");
  }

  private openTag(m: DocMark): string {
    const a = m.attrs ?? {};
    switch (m.type) {
      case "link": {
        const raw = String(a.href ?? "");
        const target = noteLinkTarget(raw);
        const href = target ? (this.ctx.noteLink?.(target) ?? raw) : raw;
        const title = typeof a.title === "string" ? ` title="${escapeAttr(a.title)}"` : "";
        return `<a href="${escapeAttr(href)}"${title}>`;
      }
      case "textStyle": {
        const parts: string[] = [];
        if (typeof a.color === "string") parts.push(`color:${a.color}`);
        if (typeof a.fontFamily === "string") parts.push(`font-family:${a.fontFamily}`);
        if (typeof a.fontSize === "string") parts.push(`font-size:${a.fontSize}`);
        return `<span style="${escapeAttr(parts.join(";"))}">`;
      }
      case "bold":
        return "<b>";
      case "italic":
        return "<i>";
      case "underline":
        return "<u>";
      case "strike":
        return "<s>";
      case "code":
        return "<code>";
      case "subscript":
        return "<sub>";
      case "superscript":
        return "<sup>";
      case "highlight": {
        const color = typeof a.color === "string" ? a.color : null;
        // Evernote's older marker for a highlight without a stated color; the converter reads it back as no color.
        if (!color) return '<span style="-evernote-highlight:true">';
        return `<span style="${escapeAttr(`--en-highlight:${highlightName(color)};background-color:${color}`)}">`;
      }
      default:
        this.warn("unknown_mark", m.type);
        return "<span>";
    }
  }

  private atom(n: DocNode): string {
    switch (n.type) {
      case "text": {
        const t = n.text ?? "";
        return NEEDS_PRE.test(t) ? `<span style="white-space:pre-wrap">${escapeText(t)}</span>` : escapeText(t);
      }
      case "hardBreak":
        return "<br/>";
      case "attachment":
        return this.attachment(n);
      case "image": {
        const src = (str(n, "src") ?? "").trim();
        if (!src) return "";
        const alt = str(n, "alt");
        const w = num(n, "width");
        const h = num(n, "height");
        return `<img src="${escapeAttr(src)}"${alt ? ` alt="${escapeAttr(alt)}"` : ""}${w ? ` width="${w}"` : ""}${h ? ` height="${h}"` : ""}/>`;
      }
      case "encrypted": {
        const hint = str(n, "hint");
        const cipher = str(n, "cipher") ?? "RC2";
        const length = num(n, "length") ?? 64;
        return `<en-crypt cipher="${escapeAttr(cipher)}" length="${length}"${hint !== null ? ` hint="${escapeAttr(hint)}"` : ""}>${escapeText(str(n, "ciphertext") ?? "")}</en-crypt>`;
      }
      case "unsupported":
        // The element as it was in the original ENML, written back as well-formed XML.
        return toXml(parseFragment(str(n, "raw") ?? ""));
      default:
        this.warn("unknown_inline", n.type);
        return n.text ? escapeText(n.text) : "";
    }
  }

  private attachment(n: DocNode): string {
    const id = str(n, "resourceId");
    const r = id ? this.ctx.resource(id) : null;
    if (!id || !r) {
      this.warn("attachment_missing", str(n, "filename") ?? id ?? "(no id)");
      return "";
    }
    if (!this.resourceIds.includes(id)) this.resourceIds.push(id);
    const w = num(n, "width");
    const h = num(n, "height");
    return `<en-media hash="${r.md5}" type="${escapeAttr(r.mime)}"${w ? ` width="${w}"` : ""}${h ? ` height="${h}"` : ""}/>`;
  }

  private taskList(n: DocNode): string {
    const out: string[] = [];
    let todos: DocNode[] = [];
    let tasks: DocNode[] = [];
    const flushTodos = () => {
      if (!todos.length) return;
      const items = todos.map((it) => `<li style="--en-checked:${it.attrs?.checked === true}">${this.blocks(it)}</li>`);
      out.push(`<ul style="--en-todo:true">${items.join("")}</ul>`);
      todos = [];
    };
    const flushTasks = () => {
      if (!tasks.length) return;
      const groupId = (this.ctx.groupId ?? defaultGroupId)(this.groups++);
      tasks.forEach((it, i) => {
        const due = str(it, "due");
        this.tasks.push({
          id: str(it, "taskId") as string,
          title: inlineText((it.content ?? [])[0] as DocNode),
          status: it.attrs?.checked === true ? "completed" : "open",
          flag: it.attrs?.flagged === true,
          sortWeight: String(i + 1).padStart(6, "0"),
          groupId,
          dueDate: due && Number.isFinite(Date.parse(due)) ? new Date(due).toISOString() : null,
        });
      });
      out.push(`<div style="--en-task-group:true;--en-id:${groupId}"></div>`);
      tasks = [];
    };
    for (const it of n.content ?? []) {
      if (str(it, "taskId") && this.isPlainTask(it)) {
        flushTodos();
        tasks.push(it);
      } else {
        if (str(it, "taskId")) this.warn("task_as_checkbox", inlineText((it.content ?? [])[0] ?? { type: "x" }));
        flushTasks();
        todos.push(it);
      }
    }
    flushTodos();
    flushTasks();
    return out.join("");
  }

  // An Evernote Task holds one line of plain text; anything more is kept by writing the item as a checkbox instead.
  private isPlainTask(it: DocNode): boolean {
    const content = it.content ?? [];
    if (content.length !== 1 || content[0]?.type !== "paragraph") return false;
    const inline = content[0].content ?? [];
    if (!inline.every((c) => c.type === "text" && !c.marks?.length)) return false;
    const text = inlineText(content[0]);
    return text === text.trim() && !/\n/.test(text);
  }

  private codeBlock(n: DocNode): string {
    const text = inlineText(n);
    const lines = text.split("\n").map((l) => (l ? `<div>${escapeText(l)}</div>` : "<div><br/></div>"));
    if (/\n$/.test(text)) this.warn("code_trailing_newline", "trailing empty lines of a code block aren't kept");
    return `<div style="--en-codeblock:true">${text ? lines.join("") : ""}</div>`;
  }

  private table(n: DocNode): string {
    const rows = (n.content ?? []).map((row) => {
      const cells = (row.content ?? []).map((cell) => {
        const tag = cell.type === "tableHeader" ? "th" : "td";
        const colspan = num(cell, "colspan") ?? 1;
        const rowspan = num(cell, "rowspan") ?? 1;
        const colwidth = cell.attrs?.colwidth;
        const width =
          Array.isArray(colwidth) && colwidth.length === 1 && typeof colwidth[0] === "number" ? colwidth[0] : null;
        if (Array.isArray(colwidth) && colwidth.length > 1) this.warn("formatting_dropped", "widths of merged columns");
        const align = str(cell, "align");
        // Only what the cell needs: the importer counts styled elements when it decides whether a note is a web page.
        const style: string[] = [];
        if (width && colspan === 1) style.push(`width:${width}px`);
        if (align) style.push(`text-align:${align}`);
        const attrs = `${colspan > 1 ? ` colspan="${colspan}"` : ""}${rowspan > 1 ? ` rowspan="${rowspan}"` : ""}${style.length ? ` style="${escapeAttr(style.join(";"))}"` : ""}`;
        return `<${tag}${attrs}>${this.blocks(cell)}</${tag}>`;
      });
      return `<tr>${cells.join("")}</tr>`;
    });
    return `<table><tbody>${rows.join("")}</tbody></table>`;
  }

  /** A note that is only a clip: written as the note itself, as the import found it, if it would be read back as a clip. */
  soleClip(n: DocNode): string {
    const html = this.clipHtml(n);
    const clip = clipToEnml(html, this.clipCtx());
    this.adopt(clip);
    if (clip.wrapped) return clip.enml;
    const size = ENML_HEADER.length + clip.enml.length + 20;
    if (shouldPreserveAsClip(measureClip(clip.nodes), size, DEFAULT_CLIP_THRESHOLDS, false)) return clip.enml;
    return this.wrap(clip.enml);
  }

  private clip(n: DocNode): string {
    const clip = clipToEnml(this.clipHtml(n), this.clipCtx());
    this.adopt(clip);
    return clip.wrapped ? clip.enml : this.wrap(clip.enml);
  }

  private wrap(enml: string): string {
    return `<div style="--en-clipped-content:fullPage">${enml}</div>`;
  }

  private clipHtml(n: DocNode): string {
    const html = String(n.attrs?.html ?? "");
    return this.ctx.cleanClip ? this.ctx.cleanClip(html, n.attrs?.sanitizerVersion ?? null) : html;
  }

  private clipCtx() {
    return {
      resource: (id: string) => this.ctx.resource(id),
      noteLink: (id: string) => this.ctx.noteLink?.(id) ?? null,
    };
  }

  private adopt(clip: ReturnType<typeof clipToEnml>) {
    for (const id of clip.resourceIds) if (!this.resourceIds.includes(id)) this.resourceIds.push(id);
    for (const id of clip.missing) this.warn("attachment_missing", id);
  }
}

function sameMarkAttrs(a: DocMark | undefined, b: DocMark | undefined): boolean {
  if (!a || !b || a.type !== b.type) return false;
  const ka = Object.entries(a.attrs ?? {}).filter(([, v]) => v !== null && v !== undefined);
  const kb = Object.entries(b.attrs ?? {}).filter(([, v]) => v !== null && v !== undefined);
  return ka.length === kb.length && ka.every(([k, v]) => b.attrs?.[k] === v);
}

function closeTag(m: DocMark): string {
  switch (m.type) {
    case "link":
      return "</a>";
    case "bold":
      return "</b>";
    case "italic":
      return "</i>";
    case "underline":
      return "</u>";
    case "strike":
      return "</s>";
    case "code":
      return "</code>";
    case "subscript":
      return "</sub>";
    case "superscript":
      return "</sup>";
    default:
      return "</span>";
  }
}
