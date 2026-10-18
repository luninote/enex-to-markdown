import { blockCss, type DocMark, type DocNode, inlineText, num, sortedMarks, str } from "./doc.ts";
import { fragmentText } from "./markup.ts";
import { clipForFile, isImage, linkTarget, type RenderContext, textStyleCss } from "./render.ts";
import { escapeAttr, escapeText } from "./xml.ts";

// A note as a standalone HTML file that opens in any browser, offline: attachments are relative links into the
// archive, links to other notes point at their files, web clips keep their own page in a sandboxed frame.

export function docToHtml(doc: DocNode, ctx: RenderContext): string {
  return new HtmlWriter(ctx).blocks(doc.content ?? []);
}

export interface NotePageMeta {
  title: string;
  notebook?: string | null;
  stack?: string | null;
  tags?: string[];
  created?: string | null;
  updated?: string | null;
  author?: string | null;
  sourceUrl?: string | null;
  reminderAt?: string | null;
  trashed?: boolean;
}

const PAGE_CSS = `
:root{color-scheme:light dark;--fg:#1d1f23;--muted:#5c6370;--line:#d5d8dd;--code:#f2f3f5}
@media (prefers-color-scheme:dark){:root{--fg:#e6e7ea;--muted:#a1a7b3;--line:#3a3f47;--code:#25282e}}
body{margin:0;padding:2rem 1rem;font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--fg)}
article{max-width:48rem;margin:0 auto}
h1.title{font-size:1.75rem;line-height:1.25;margin:0 0 .5rem}
dl.meta{display:grid;grid-template-columns:max-content 1fr;gap:.15rem 1rem;margin:0 0 1.5rem;padding-bottom:1rem;border-bottom:1px solid var(--line);font-size:.875rem;color:var(--muted)}
dl.meta dt{font-weight:600}dl.meta dd{margin:0;overflow-wrap:anywhere}
.note img{max-width:100%;height:auto}
.note table{border-collapse:collapse;margin:.75rem 0}
.note td,.note th{border:1px solid var(--line);padding:.3rem .6rem;vertical-align:top}
.note pre{background:var(--code);padding:.75rem;overflow-x:auto;border-radius:6px}
.note code{background:var(--code);padding:0 .2em;border-radius:3px}
.note pre code{padding:0;background:none}
.note blockquote{margin:.75rem 0;padding-left:1rem;border-left:3px solid var(--line);color:var(--muted)}
.note ul.tasks{list-style:none;padding-left:1.25rem}.note ul.tasks>li>input{margin:0 .4rem 0 -1.25rem}
.note .task-meta{color:var(--muted);font-size:.85em;margin-left:.5rem}
.note .file{display:inline-block;padding:.15rem .5rem;border:1px solid var(--line);border-radius:4px;text-decoration:none}
.note .missing,.note .encrypted,.note .unsupported{color:var(--muted);font-style:italic}
.note iframe.clip{width:100%;height:70vh;border:1px solid var(--line);border-radius:6px;resize:vertical}
`;

const when = (v: string | null | undefined) =>
  v && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) ? `${v.slice(0, 10)} ${v.slice(11, 16)} UTC` : v;

export function notePage(meta: NotePageMeta, bodyHtml: string): string {
  const rows: [string, string | null | undefined][] = [
    ["Notebook", meta.stack ? `${meta.stack} / ${meta.notebook ?? ""}` : meta.notebook],
    ["Tags", meta.tags?.length ? meta.tags.join(", ") : null],
    ["Created", when(meta.created)],
    ["Updated", when(meta.updated)],
    ["Reminder", when(meta.reminderAt)],
    ["Author", meta.author],
    ["In the Trash", meta.trashed ? "yes" : null],
  ];
  const dl = rows
    .filter(([, v]) => v)
    .map(([k, v]) => `<dt>${k}</dt><dd>${escapeText(v as string)}</dd>`)
    .join("");
  const source = meta.sourceUrl ? linkTarget(meta.sourceUrl, { attachment: () => null, noteLink: () => null }) : null;
  const sourceRow =
    source?.kind === "url"
      ? `<dt>Source</dt><dd><a href="${escapeAttr(source.href)}">${escapeText(meta.sourceUrl as string)}</a></dd>`
      : meta.sourceUrl
        ? `<dt>Source</dt><dd>${escapeText(meta.sourceUrl)}</dd>`
        : "";
  const title = meta.title || "Untitled";
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeText(title)}</title><style>${PAGE_CSS}</style></head>
<body><article><h1 class="title">${escapeText(title)}</h1><dl class="meta">${dl}${sourceRow}</dl><div class="note">${bodyHtml}</div></article></body></html>
`;
}

class HtmlWriter {
  private readonly ctx: RenderContext;

  constructor(ctx: RenderContext) {
    this.ctx = ctx;
  }

  blocks(nodes: DocNode[]): string {
    return nodes.map((n) => this.block(n)).join("\n");
  }

  block(n: DocNode): string {
    switch (n.type) {
      case "paragraph": {
        const css = blockCss(n, "em");
        return `<p${css ? ` style="${css}"` : ""}>${this.inline(n.content ?? []) || "<br>"}</p>`;
      }
      case "heading": {
        const level = Math.min(6, Math.max(1, num(n, "level") ?? 1));
        const css = blockCss(n, "em");
        return `<h${level}${css ? ` style="${css}"` : ""}>${this.inline(n.content ?? [])}</h${level}>`;
      }
      case "blockquote":
        return `<blockquote>${this.blocks(n.content ?? [])}</blockquote>`;
      case "horizontalRule":
        return "<hr>";
      case "bulletList":
        return `<ul>${this.items(n)}</ul>`;
      case "orderedList": {
        const start = num(n, "start");
        const type = str(n, "type");
        return `<ol${start !== null && start !== 1 ? ` start="${start}"` : ""}${type && /^[aAiI1]$/.test(type) ? ` type="${type}"` : ""}>${this.items(n)}</ol>`;
      }
      case "taskList":
        return `<ul class="tasks">${(n.content ?? [])
          .map((it) => {
            const checked = it.attrs?.checked === true;
            const meta: string[] = [];
            const due = str(it, "due");
            if (due) meta.push(`due ${due.slice(0, 16).replace("T", " ")}`);
            if (it.attrs?.flagged === true) meta.push("flagged");
            const extra = meta.length ? `<span class="task-meta">(${escapeText(meta.join(", "))})</span>` : "";
            const [first, ...rest] = it.content ?? [];
            const head = first ? this.inline(first.content ?? []) : "";
            return `<li><input type="checkbox" disabled${checked ? " checked" : ""}>${head}${extra}${rest.length ? this.blocks(rest) : ""}</li>`;
          })
          .join("")}</ul>`;
      case "codeBlock": {
        const lang = str(n, "language");
        const cls = lang && /^[\w+#.-]{1,40}$/.test(lang) ? ` class="language-${lang}"` : "";
        return `<pre><code${cls}>${escapeText(inlineText(n))}</code></pre>`;
      }
      case "table":
        return `<table>${(n.content ?? [])
          .map(
            (row) =>
              `<tr>${(row.content ?? [])
                .map((cell) => {
                  const tag = cell.type === "tableHeader" ? "th" : "td";
                  const colspan = num(cell, "colspan") ?? 1;
                  const rowspan = num(cell, "rowspan") ?? 1;
                  const cw = cell.attrs?.colwidth;
                  // Stored documents are untrusted: a string among the widths would be written into the attribute.
                  const width =
                    Array.isArray(cw) &&
                    cw.length > 0 &&
                    cw.every((w) => typeof w === "number" && Number.isFinite(w) && w >= 0 && w <= 100_000)
                      ? Math.round((cw as number[]).reduce((a, b) => a + b, 0))
                      : null;
                  const align = str(cell, "align");
                  const style = [
                    width ? `width:${width}px` : "",
                    align && /^(left|center|right)$/.test(align) ? `text-align:${align}` : "",
                  ]
                    .filter(Boolean)
                    .join(";");
                  return `<${tag}${colspan > 1 ? ` colspan="${colspan}"` : ""}${rowspan > 1 ? ` rowspan="${rowspan}"` : ""}${style ? ` style="${escapeAttr(style)}"` : ""}>${this.blocks(cell.content ?? [])}</${tag}>`;
                })
                .join("")}</tr>`,
          )
          .join("")}</table>`;
      case "webClip":
        return this.clip(n);
      default:
        return n.content ? `<div>${escapeText(inlineText(n))}</div>` : "";
    }
  }

  private items(n: DocNode): string {
    return (n.content ?? []).map((li) => `<li>${this.blocks(li.content ?? [])}</li>`).join("");
  }

  inline(nodes: DocNode[]): string {
    return nodes.map((n) => this.wrap(this.atom(n), sortedMarks(n.marks))).join("");
  }

  private wrap(inner: string, marks: DocMark[]): string {
    let out = inner;
    for (let i = marks.length - 1; i >= 0; i--) {
      const m = marks[i] as DocMark;
      switch (m.type) {
        case "bold":
          out = `<strong>${out}</strong>`;
          break;
        case "italic":
          out = `<em>${out}</em>`;
          break;
        case "underline":
          out = `<u>${out}</u>`;
          break;
        case "strike":
          out = `<s>${out}</s>`;
          break;
        case "code":
          out = `<code>${out}</code>`;
          break;
        case "subscript":
          out = `<sub>${out}</sub>`;
          break;
        case "superscript":
          out = `<sup>${out}</sup>`;
          break;
        case "highlight": {
          const css = textStyleCss({ color: m.attrs?.color });
          out = `<mark${css ? ` style="background-${css}"` : ""}>${out}</mark>`;
          break;
        }
        case "textStyle": {
          const css = textStyleCss(m.attrs);
          if (css) out = `<span style="${escapeAttr(css)}">${out}</span>`;
          break;
        }
        case "link": {
          const t = linkTarget(String(m.attrs?.href ?? ""), this.ctx);
          if (t.kind !== "none") {
            const title = typeof m.attrs?.title === "string" ? ` title="${escapeAttr(m.attrs.title)}"` : "";
            out = `<a href="${escapeAttr(t.href)}"${title}>${out}</a>`;
          }
          break;
        }
      }
    }
    return out;
  }

  private atom(n: DocNode): string {
    switch (n.type) {
      case "text":
        return escapeText(n.text ?? "");
      case "hardBreak":
        return "<br>";
      case "attachment": {
        const id = str(n, "resourceId");
        const a = id ? this.ctx.attachment(id) : null;
        const name = str(n, "filename") ?? a?.filename ?? "attachment";
        if (!a) return `<span class="missing">[${escapeText(name)}]</span>`;
        const w = num(n, "width");
        const h = num(n, "height");
        if (isImage(a.mime) && str(n, "display") !== "card")
          return `<img src="${escapeAttr(a.href)}" alt="${escapeAttr(name)}"${w ? ` width="${w}"` : ""}${h ? ` height="${h}"` : ""}>`;
        return `<a class="file" href="${escapeAttr(a.href)}">${escapeText(name)}</a>`;
      }
      case "image": {
        const src = str(n, "src") ?? "";
        if (!/^(https?:|data:image\/)/i.test(src)) return "";
        const alt = str(n, "alt");
        const w = num(n, "width");
        const h = num(n, "height");
        return `<img src="${escapeAttr(src)}" alt="${escapeAttr(alt ?? "")}"${w ? ` width="${w}"` : ""}${h ? ` height="${h}"` : ""}>`;
      }
      case "encrypted": {
        // The ciphertext stays in the file, so the text can still be decrypted with Evernote's password later.
        const hint = str(n, "hint");
        return `<span class="encrypted" data-cipher="${escapeAttr(str(n, "cipher") ?? "RC2")}" data-length="${num(n, "length") ?? 64}" data-ciphertext="${escapeAttr(str(n, "ciphertext") ?? "")}"${hint ? ` title="Hint: ${escapeAttr(hint)}"` : ""}>[Encrypted text]</span>`;
      }
      case "unsupported": {
        const text = fragmentText(str(n, "raw") ?? "");
        return `<span class="unsupported">${escapeText(text || "[Content kept in the ENEX and JSON files]")}</span>`;
      }
      default:
        return n.text ? escapeText(n.text) : "";
    }
  }

  private clip(n: DocNode): string {
    const body = clipForFile(n, this.ctx, false);
    const doc = `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>body{margin:0;padding:8px;font:15px/1.5 system-ui,sans-serif}img{max-width:100%;height:auto}</style></head><body>${body}</body></html>`;
    return `<iframe class="clip" sandbox="allow-popups allow-popups-to-escape-sandbox" title="Saved web page" srcdoc="${escapeAttr(doc)}"></iframe>`;
  }
}
