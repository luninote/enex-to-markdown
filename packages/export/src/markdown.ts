import { type DocMark, type DocNode, inlineText, noteLinkTarget, num, sameMark, sortedMarks, str } from "./doc.ts";
import { docToHtml } from "./html.ts";
import { fragmentText } from "./markup.ts";
import { clipForFile, isImage, linkTarget, type RenderContext, textStyleCss } from "./render.ts";
import { escapeAttr, escapeText, xmlSafe } from "./xml.ts";

// A note as GitHub-flavoured Markdown. What Markdown has no syntax for (underline, highlight, colors and fonts,
// merged table cells, image sizes, encrypted text, web clips) is written as inline HTML, which GFM renders, instead of
// being dropped.

export function docToMarkdown(doc: DocNode, ctx: RenderContext): string {
  const w = new MarkdownWriter(ctx);
  return `${w
    .blocks(doc.content ?? [])
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()}\n`;
}

const DELIMS: Record<string, [string, string]> = {
  bold: ["**", "**"],
  italic: ["*", "*"],
  strike: ["~~", "~~"],
};
const HTML_EQUIV: Record<string, [string, string]> = {
  bold: ["<strong>", "</strong>"],
  italic: ["<em>", "</em>"],
  strike: ["<del>", "</del>"],
};
const PUNCT = /[!-/:-@[-`{-~\p{P}\p{S}]/u;

function escapeInline(s: string, extra = false): string {
  const out = xmlSafe(s)
    .replace(/[\\`*_[\]<>~|]/g, "\\$&")
    .replace(/&(?=[a-zA-Z#])/g, "&amp;");
  return extra ? out.replace(/\$/g, "\\$").replace(/=(?==)/g, "\\=") : out;
}

// Characters that end or split a wikilink; the text shown for the link can't hold them.
const wikiText = (s: string) =>
  s
    .replace(/\s+/g, " ")
    .replace(/\[\[|\]\]/g, (m) => m[0] as string)
    .trim();

const EMBEDDABLE = /^(image|audio|video)\/|^application\/pdf$/i;

const CELL_BLOCKS = new Set([
  "paragraph",
  "heading",
  "blockquote",
  "horizontalRule",
  "codeBlock",
  "bulletList",
  "orderedList",
  "taskList",
]);

// Text at the start of a line that Markdown would read as a heading, list, quote, rule or code fence.
function escapeLineStart(line: string): string {
  return line
    .replace(/^(\s*)([#>+=-])/, "$1\\$2")
    .replace(/^(\s*\d+)([.)])/, "$1\\$2")
    .replace(/^ {4,}/, (m) => `&#32;${m.slice(1)}`);
}

class MarkdownWriter {
  private readonly ctx: RenderContext;

  constructor(ctx: RenderContext) {
    this.ctx = ctx;
  }

  blocks(nodes: DocNode[]): string[] {
    const out: string[] = [];
    for (const n of nodes) {
      const lines = this.block(n);
      if (!lines.length) continue;
      if (out.length) out.push("");
      out.push(...lines);
    }
    return out;
  }

  private block(n: DocNode): string[] {
    switch (n.type) {
      case "paragraph": {
        const text = this.inline(n.content ?? []);
        return text.trim() ? text.split("\n").map(escapeLineStart) : [];
      }
      case "heading": {
        const level = Math.min(6, Math.max(1, num(n, "level") ?? 1));
        const text = this.inline(n.content ?? [], "<br>").trim();
        return [`${"#".repeat(level)}${text ? ` ${text}` : ""}`];
      }
      case "blockquote":
        return this.blocks(n.content ?? []).map((l) => (l ? `> ${l}` : ">"));
      case "horizontalRule":
        return ["---"];
      case "bulletList":
        return (n.content ?? []).flatMap((li) => this.item("- ", li.content ?? []));
      case "orderedList": {
        const start = num(n, "start") ?? 1;
        return (n.content ?? []).flatMap((li, i) => this.item(`${start + i}. `, li.content ?? []));
      }
      case "taskList":
        return (n.content ?? []).flatMap((it) => {
          const lines = this.item(it.attrs?.checked === true ? "- [x] " : "- [ ] ", it.content ?? []);
          const tail = this.taskTail(it);
          if (tail && lines.length) lines[0] = `${lines[0]}${tail}`;
          return lines;
        });
      case "codeBlock": {
        const text = inlineText(n);
        const runs = text.match(/`+/g) ?? [];
        const fence = "`".repeat(Math.max(3, ...runs.map((r) => r.length + 1)));
        const lang = str(n, "language");
        return [`${fence}${lang && /^[\w+#.-]{1,40}$/.test(lang) ? lang : ""}`, ...xmlSafe(text).split("\n"), fence];
      }
      case "table":
        return this.table(n);
      case "webClip":
        return this.clip(n);
      default: {
        const text = inlineText(n);
        return text ? [this.esc(text)] : [];
      }
    }
  }

  private taskTail(it: DocNode): string {
    const custom = this.ctx.taskSuffix?.(it) ?? null;
    if (custom !== null) return custom;
    const meta: string[] = [];
    const due = str(it, "due");
    if (due) meta.push(`due ${due.slice(0, 16).replace("T", " ")}`);
    if (it.attrs?.flagged === true) meta.push("flagged");
    return meta.length ? ` *(${meta.join(", ")})*` : "";
  }

  private esc(s: string): string {
    return escapeInline(s, this.ctx.escapeExtra === true);
  }

  private item(marker: string, content: DocNode[]): string[] {
    const [first, ...rest] = content;
    // Continuation lines line up with the list marker's content; a task's "[ ] " is content, not marker.
    const indent = " ".repeat(marker.replace(/\[[ x]\] $/, "").length);
    const head =
      first?.type === "paragraph"
        ? this.inline(first.content ?? [])
            .split("\n")
            .map(escapeLineStart)
        : [];
    const restLines = this.blocks(first?.type === "paragraph" ? rest : content);
    const lines = [`${marker}${head[0] ?? ""}`.trimEnd(), ...head.slice(1).map((l) => `${indent}${l}`)];
    if (restLines.length) lines.push(...restLines.map((l) => (l ? `${indent}${l}` : "")));
    return lines;
  }

  private table(n: DocNode): string[] {
    const rows = n.content ?? [];
    const simple = rows.every((r) =>
      (r.content ?? []).every(
        (c) =>
          (num(c, "colspan") ?? 1) === 1 &&
          (num(c, "rowspan") ?? 1) === 1 &&
          (c.content ?? []).every((b) => CELL_BLOCKS.has(b.type)),
      ),
    );
    const width = Math.max(...rows.map((r) => (r.content ?? []).length));
    if (!simple || !rows.length || !Number.isFinite(width)) {
      // Merged cells, tables in tables, web clips: GFM tables can't hold them, an HTML table can.
      return [docToHtml({ type: "doc", content: [n] }, this.ctx).replace(/\n+/g, "")];
    }
    // A GFM row is one line and splits at every unescaped pipe, even inside code or a link.
    const cell = (c: DocNode | undefined) =>
      this.cellBlocks(c?.content ?? [])
        .replace(/\n/g, " ")
        .replace(/(?<!\\)\|/g, "\\|")
        .trim();
    const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
    const pad = (r: DocNode) => Array.from({ length: width }, (_, i) => cell(r.content?.[i]));
    const [head, ...body] = rows as [DocNode, ...DocNode[]];
    const aligns = Array.from({ length: width }, (_, i) => {
      const a = str(head.content?.[i] ?? { type: "x" }, "align");
      return a === "center" ? ":---:" : a === "right" ? "---:" : a === "left" ? ":---" : "---";
    });
    return [line(pad(head)), line(aligns), ...body.map((r) => line(pad(r)))];
  }

  /** Blocks inside a table cell, on one line: lists and code as inline HTML, which GFM renders inside a cell. */
  private cellBlocks(blocks: DocNode[]): string {
    return blocks
      .map((b) => {
        switch (b.type) {
          case "paragraph":
            return this.inline(b.content ?? [], "<br>");
          case "heading":
            return `<strong>${this.inline(b.content ?? [], "<br>")}</strong>`;
          case "blockquote":
            return this.cellBlocks(b.content ?? []);
          case "horizontalRule":
            return "<hr>";
          case "codeBlock":
            return `<code>${escapeText(inlineText(b)).replace(/\n/g, "<br>")}</code>`;
          case "bulletList":
          case "orderedList":
          case "taskList": {
            const tag = b.type === "orderedList" ? "ol" : "ul";
            const start = num(b, "start");
            const items = (b.content ?? []).map((li) => {
              const box = b.type === "taskList" ? (li.attrs?.checked === true ? "\\[x\\] " : "\\[ \\] ") : "";
              const suffix = b.type === "taskList" ? this.taskTail(li) : "";
              return `<li>${box}${this.cellBlocks(li.content ?? [])}${suffix}</li>`;
            });
            return `<${tag}${tag === "ol" && start !== null && start !== 1 ? ` start="${start}"` : ""}>${items.join("")}</${tag}>`;
          }
          default:
            return this.esc(inlineText(b));
        }
      })
      .filter(Boolean)
      .join("<br>");
  }

  private clip(n: DocNode): string[] {
    // An HTML block ends at a blank line, so the clip is written without any.
    const body = clipForFile(n, this.ctx, true).replace(/\n\s*\n/g, "\n");
    return [`<div class="web-clip">${body}</div>`];
  }

  /** Inline content as Markdown. Marks open and close around runs of nodes; whitespace is kept outside delimiters. */
  inline(content: DocNode[], hardBreak = "\\\n"): string {
    const nodes = this.wikiRuns(content);
    const out: string[] = [];
    const open: DocMark[] = [];
    let trailing = "";
    const closeTo = (keep: number) => {
      while (open.length > keep) out.push(this.close(open.pop() as DocMark));
    };
    nodes.forEach((n, index) => {
      if (n.type === "hardBreak") {
        closeTo(0);
        out.push(trailing);
        trailing = "";
        if (index < nodes.length - 1) out.push(hardBreak);
        return;
      }
      const marks = sortedMarks(n.marks).filter((m) => m.type !== "code");
      const code = n.marks?.some((m) => m.type === "code") ?? false;
      let lead = "";
      let core = this.atom(n, code);
      let tail = "";
      if (n.type === "text") {
        const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(core) as RegExpExecArray;
        [lead, core, tail] = [m[1] as string, m[2] as string, m[3] as string];
        if (!core) {
          closeTo(0);
          out.push(trailing, lead + tail);
          trailing = "";
          return;
        }
      }
      let common = 0;
      while (
        common < open.length &&
        common < marks.length &&
        sameMark(open[common] as DocMark, marks[common] as DocMark)
      )
        common++;
      closeTo(common);
      out.push(trailing, lead);
      trailing = "";
      for (const m of marks.slice(common)) {
        out.push(this.open(m, core));
        open.push(m);
      }
      out.push(core);
      trailing = tail;
    });
    closeTo(0);
    out.push(trailing);
    return out.join("");
  }

  /** With wikilinks on, each run of nodes linking to one note becomes a single `[[target|text]]` node. */
  private wikiRuns(nodes: DocNode[]): DocNode[] {
    const wiki = this.ctx.wikiLinks;
    if (!wiki) return nodes;
    const linkOf = (n: DocNode) => n.marks?.find((m) => m.type === "link");
    const out: DocNode[] = [];
    for (let i = 0; i < nodes.length; ) {
      const n = nodes[i] as DocNode;
      const link = linkOf(n);
      const id = link ? noteLinkTarget(String(link.attrs?.href ?? "")) : null;
      const target = id ? wiki.note(id) : null;
      if (!link || !target) {
        out.push(n);
        i++;
        continue;
      }
      const run: DocNode[] = [];
      while (i < nodes.length) {
        const m = linkOf(nodes[i] as DocNode);
        if (!m || !sameMark(m, link)) break;
        run.push(nodes[i] as DocNode);
        i++;
      }
      const text = wikiText(
        run.map((r) => (r.type === "text" ? (r.text ?? "") : r.type === "hardBreak" ? " " : "")).join(""),
      );
      const shown = target.slice(target.lastIndexOf("/") + 1);
      const marks = (run[0]?.marks ?? []).filter(
        (m) => m.type !== "link" && m.type !== "code" && run.every((r) => r.marks?.some((x) => sameMark(x, m))),
      );
      out.push({ type: "wikilink", text: `[[${text && text !== shown ? `${target}|${text}` : target}]]`, marks });
    }
    return out;
  }

  private open(m: DocMark, core: string): string {
    const delim = DELIMS[m.type];
    if (delim) {
      // Emphasis next to punctuation often doesn't parse as emphasis; HTML always does.
      const html = PUNCT.test(core[0] ?? "") || PUNCT.test(core[core.length - 1] ?? "");
      const pair = html ? (HTML_EQUIV[m.type] as [string, string]) : delim;
      this.closers.set(m, pair[1]);
      return pair[0];
    }
    switch (m.type) {
      case "link": {
        // A link that can't point anywhere in the archive stays as its text.
        if (linkTarget(String(m.attrs?.href ?? ""), this.ctx).kind !== "none") return "[";
        this.closers.set(m, "");
        return "";
      }
      case "underline":
        return "<u>";
      case "subscript":
        return "<sub>";
      case "superscript":
        return "<sup>";
      case "highlight": {
        if (this.ctx.highlight === "equals") {
          this.closers.set(m, "==");
          return "==";
        }
        const css = this.ctx.textStyles === false ? "" : textStyleCss({ color: m.attrs?.color });
        return css ? `<mark style="background-${css}">` : "<mark>";
      }
      case "textStyle": {
        if (this.ctx.textStyles === false) {
          this.closers.set(m, "");
          return "";
        }
        const css = textStyleCss(m.attrs);
        return css ? `<span style="${escapeAttr(css)}">` : "<span>";
      }
      default:
        return "";
    }
  }

  private readonly closers = new Map<DocMark, string>();

  private close(m: DocMark): string {
    const delim = DELIMS[m.type];
    if (delim) return this.closers.get(m) ?? delim[1];
    switch (m.type) {
      case "link": {
        if (this.closers.get(m) === "") return "";
        const t = linkTarget(String(m.attrs?.href ?? ""), this.ctx);
        if (t.kind === "none") return "";
        const title = typeof m.attrs?.title === "string" ? ` "${m.attrs.title.replace(/"/g, '\\"')}"` : "";
        return `](<${t.href.replace(/[<>]/g, encodeURIComponent)}>${title})`;
      }
      case "underline":
        return "</u>";
      case "subscript":
        return "</sub>";
      case "superscript":
        return "</sup>";
      case "highlight":
        return this.closers.get(m) ?? "</mark>";
      case "textStyle":
        return this.closers.get(m) ?? "</span>";
      default:
        return "";
    }
  }

  private atom(n: DocNode, code: boolean): string {
    switch (n.type) {
      case "text": {
        const t = n.text ?? "";
        if (!code) return this.esc(t);
        const runs = t.match(/`+/g) ?? [];
        const fence = "`".repeat(Math.max(1, ...runs.map((r) => r.length + 1)));
        const pad = /^`|`$|^ .* $/.test(t) ? " " : "";
        return `${fence}${pad}${xmlSafe(t).replace(/\n/g, " ")}${pad}${fence}`;
      }
      case "attachment": {
        const id = str(n, "resourceId");
        const a = id ? this.ctx.attachment(id) : null;
        const name = str(n, "filename") ?? a?.filename ?? "attachment";
        if (!a) return `${this.esc(`[${name}]`)} (missing)`;
        const w = num(n, "width");
        const h = num(n, "height");
        const wiki = id ? (this.ctx.wikiLinks?.attachment(id) ?? null) : null;
        if (wiki) {
          if (!EMBEDDABLE.test(a.mime ?? "") || (isImage(a.mime) && str(n, "display") === "card")) {
            const shown = wikiText(name);
            return `[[${wiki}${shown && shown !== wiki.slice(wiki.lastIndexOf("/") + 1) ? `|${shown}` : ""}]]`;
          }
          const size = isImage(a.mime) && w ? `|${w}${h ? `x${h}` : ""}` : "";
          return `![[${wiki}${size}]]`;
        }
        if (isImage(a.mime) && str(n, "display") !== "card") {
          if (w || h)
            return `<img src="${escapeAttr(a.href)}" alt="${escapeAttr(name)}"${w ? ` width="${w}"` : ""}${h ? ` height="${h}"` : ""}>`;
          return `![${escapeInline(name)}](<${a.href}>)`;
        }
        return `[${escapeInline(name)}](<${a.href}>)`;
      }
      case "image": {
        const src = str(n, "src") ?? "";
        if (!/^(https?:|data:image\/)/i.test(src)) return "";
        const alt = str(n, "alt") ?? "";
        const w = num(n, "width");
        const h = num(n, "height");
        if (w || h || /[<>\s]/.test(src))
          return `<img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}"${w ? ` width="${w}"` : ""}${h ? ` height="${h}"` : ""}>`;
        return `![${escapeInline(alt)}](<${src}>)`;
      }
      case "encrypted": {
        const hint = str(n, "hint");
        return `<span class="encrypted" data-cipher="${escapeAttr(str(n, "cipher") ?? "RC2")}" data-length="${num(n, "length") ?? 64}" data-ciphertext="${escapeAttr(str(n, "ciphertext") ?? "")}"${hint ? ` title="Hint: ${escapeAttr(hint)}"` : ""}>[Encrypted text]</span>`;
      }
      case "unsupported": {
        const text = fragmentText(str(n, "raw") ?? "");
        return this.esc(text || "[Content kept in the ENEX and JSON files]");
      }
      case "wikilink":
        return n.text ?? "";
      default:
        return n.text ? escapeInline(n.text) : escapeText("");
    }
  }
}
