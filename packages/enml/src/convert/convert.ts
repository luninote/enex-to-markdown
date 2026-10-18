import {
  type Alignment,
  compactDoc,
  getEditorSchema,
  indentSteps,
  MAX_INDENT,
  normalizeColor,
  parseAlignment,
  SANITIZER_VERSION,
} from "@luninote/editor";
import { Fragment, type Mark, type MarkType, type NodeType, type Node as PMNode, type Schema } from "@tiptap/pm/model";
import { type AnyNode, type Element, isCDATA, isTag, isText } from "domhandler";
import { parseDocument } from "htmlparser2";
import type { LinkResolution } from "../links.ts";
import { type NoteWarning, Warnings } from "../warnings.ts";
import { type ClipThresholds, DEFAULT_CLIP_THRESHOLDS, measureClip, shouldPreserveAsClip } from "./clip.ts";
import {
  backgroundColor,
  cssColor,
  cssFontFamily,
  cssFontSize,
  cssPixels,
  enProp,
  htmlFontSize,
  isTruthy,
  parseStyle,
} from "./css.ts";
import { type Rewrite, serialize, textContent } from "./html.ts";

/** One `<resource>` of the note, as the importer stored it. en-media elements find it by the MD5 of its bytes. */
export interface ConvertResource {
  md5: string;
  resourceId: string;
  mime: string;
  filename: string | null;
}

/** An Evernote Task of the note (ENEX `<task>`); the reader's EnexTask fits. */
export interface ConvertTask {
  /** `noteLevelID`. Tasks without one get a generated id, unique within the note. */
  id?: string | null;
  title: string;
  status: string | null;
  flag?: boolean;
  dueDate?: Date | null;
  sortWeight: string | null;
  groupId: string | null;
}

export interface ConvertOptions {
  resources?: readonly ConvertResource[];
  /** Stores an inline `data:` image as a resource. Return null to keep it out of the note (reported). */
  storeDataImage?: (mime: string, bytes: Uint8Array) => ConvertResource | null;
  /** Rewrites links between notes. Return null for links that are not Evernote links. */
  resolveLink?: (href: string, text: string) => LinkResolution | null;
  /** Required for web clips: without a sanitizer every note is converted to editable content. */
  sanitizeHtml?: (html: string) => string;
  /** The SANITIZER_VERSION that `sanitizeHtml` implements, stamped on clips. Defaults to the editor's current one. */
  sanitizerVersion?: number | null;
  tasks?: readonly ConvertTask[];
  clip?: Partial<ClipThresholds>;
}

export interface ConvertStats {
  mediaRefs: number;
  mediaMissing: string[];
  referencedResources: number;
  unreferencedResources: number;
  dataImages: number;
  linksResolved: number;
  linksUnresolved: number;
  encrypted: number;
  tasks: number;
  webClip: boolean;
  unsupported: number;
  codeBlocksSplit: number;
}

export interface ConvertResult {
  /** ProseMirror JSON (`{ type: "doc", content }`), valid under `checkDoc`. */
  doc: Record<string, unknown>;
  node: PMNode;
  warnings: NoteWarning[];
  stats: ConvertStats;
}

// One code block is one text node, and typing in a 50k-line block is slow.
export const CODE_BLOCK_MAX_LINES = 1000;
export const CODE_BLOCK_MAX_CHARS = 100_000;

const BR = { kind: "br" } as const;
type Todo = { kind: "todo"; checked: boolean };
type InlineItem = PMNode | typeof BR | Todo;

interface Ctx {
  marks: readonly Mark[];
  pre: boolean;
  /** Block formatting the paragraphs made here inherit (schema v3): text-align inherits in CSS, indents add up. */
  align: Alignment | null;
  indent: number;
}

interface State {
  run: InlineItem[];
  out: PMNode[];
  align?: Alignment | null;
  indent?: number;
}

const INLINE_TAGS = new Set([
  "span",
  "font",
  "b",
  "strong",
  "i",
  "em",
  "cite",
  "var",
  "dfn",
  "u",
  "ins",
  "s",
  "strike",
  "del",
  "code",
  "tt",
  "kbd",
  "samp",
  "abbr",
  "acronym",
  "q",
  "big",
  "small",
  "sub",
  "sup",
  "bdo",
  "bdi",
  "label",
  "mark",
  "nobr",
  "time",
  "data",
  "wbr",
]);

const BLOCK_TAGS = new Set([
  "div",
  "p",
  "center",
  "address",
  "caption",
  "dl",
  "dt",
  "dd",
  "section",
  "article",
  "header",
  "footer",
  "nav",
  "aside",
  "main",
  "figure",
  "figcaption",
  "hgroup",
  "details",
  "summary",
  "form",
  "fieldset",
  "legend",
  "en-note",
  "body",
  "html",
  "li",
  "tr",
  "td",
  "th",
  "tbody",
  "thead",
  "tfoot",
  "colgroup",
  "col",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "menu",
  "dir",
  "table",
  "blockquote",
  "pre",
  "xmp",
  "listing",
  "plaintext",
  "hr",
]);

const DROPPED_TAGS = new Set(["script", "style", "noscript", "head", "title", "meta", "link", "base", "template"]);
const CODE_TAGS = new Set(["pre", "xmp", "listing", "plaintext"]);
const LIST_TAGS = new Set(["ul", "ol", "menu", "dir"]);

const isWhitespace = (s: string) => !/[^ \t\n\r\f]/.test(s);

function clampInt(v: string | undefined, min: number, max: number): number | null {
  if (v === undefined) return null;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null;
}

function attrPixels(el: Element, name: "width" | "height", style: Map<string, string>): number | null {
  return cssPixels(el.attribs[name]) ?? cssPixels(style.get(name));
}

function findElement(nodes: readonly AnyNode[], name: string): Element | null {
  for (const n of nodes) {
    if (!isTag(n)) continue;
    if (n.name === name) return n;
    const found = findElement(n.children, name);
    if (found) return found;
  }
  return null;
}

function decodeDataUri(src: string): { mime: string; bytes: Uint8Array } | null {
  const m = /^data:([^;,]*)((?:;[^;,]*)*?),(.*)$/s.exec(src.trim());
  if (!m) return null;
  const mime = (m[1] || "application/octet-stream").toLowerCase();
  const payload = m[3] ?? "";
  try {
    if (/;base64/i.test(m[2] ?? "")) {
      const b64 = payload.replace(/[^A-Za-z0-9+/=_-]/g, "");
      return { mime, bytes: Uint8Array.from(atob(b64.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)) };
    }
    return { mime, bytes: new TextEncoder().encode(decodeURIComponent(payload)) };
  } catch {
    return null;
  }
}

/**
 * Converts one note's ENML into our document. Never throws: when the structured conversion
 * fails, the note becomes a preserved web clip (or an `unsupported` block holding the ENML) and says so.
 */
export function convertEnml(enml: string, options: ConvertOptions = {}): ConvertResult {
  const converter = new Converter(options);
  return converter.run(cleanInput(enml));
}

// NUL is illegal in Postgres text and jsonb; lone surrogates break JSON round trips.
function docJson(node: PMNode): Record<string, unknown> {
  return compactDoc(node.toJSON()) as Record<string, unknown>;
}

function cleanInput(s: string): string {
  return s
    .replaceAll("\u0000", "")
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�");
}

class Converter {
  private readonly schema: Schema = getEditorSchema();
  private readonly t = schemaTypes();
  private readonly warnings = new Warnings();
  private readonly byMd5 = new Map<string, ConvertResource>();
  private readonly referenced = new Set<ConvertResource>();
  private readonly placedTasks = new Set<ConvertTask>();
  private readonly taskIds = new Set<string>();
  private readonly mergeable = new WeakSet<PMNode>();
  /** Text from white-space: pre contexts, which line trimming must leave alone. */
  private readonly preserved = new WeakSet<PMNode>();
  private readonly clip: ClipThresholds;
  private readonly stats: ConvertStats = {
    mediaRefs: 0,
    mediaMissing: [],
    referencedResources: 0,
    unreferencedResources: 0,
    dataImages: 0,
    linksResolved: 0,
    linksUnresolved: 0,
    encrypted: 0,
    tasks: 0,
    webClip: false,
    unsupported: 0,
    codeBlocksSplit: 0,
  };

  private readonly opts: ConvertOptions;

  constructor(opts: ConvertOptions) {
    this.opts = opts;
    for (const r of opts.resources ?? []) {
      const key = r.md5.toLowerCase();
      if (!this.byMd5.has(key)) this.byMd5.set(key, r);
    }
    this.clip = { ...DEFAULT_CLIP_THRESHOLDS, ...opts.clip };
  }

  run(enml: string): ConvertResult {
    let blocks: PMNode[];
    try {
      const dom = parseDocument(enml, {
        xmlMode: false,
        decodeEntities: true,
        lowerCaseTags: true,
        lowerCaseAttributeNames: true,
        recognizeSelfClosing: true,
        recognizeCDATA: true,
      });
      const root = findElement(dom.children, "en-note");
      const children = root ? root.children : dom.children;
      const ctx: Ctx = { marks: [], pre: false, align: null, indent: 0 };
      const clipped = this.tryClip(children, enml.length, false);
      blocks = clipped ?? this.blocks(children, ctx);
      blocks.push(...this.unplacedTasks(), ...this.unreferencedResources());
      return this.finish(blocks);
    } catch (err) {
      return this.fallback(enml, err);
    }
  }

  private finish(blocks: PMNode[]): ConvertResult {
    const content = blocks.length ? blocks : [this.paragraph([])];
    const node = this.schema.node("doc", null, content);
    node.check();
    this.stats.referencedResources = this.referenced.size;
    return { doc: docJson(node), node, warnings: this.warnings.list(), stats: this.stats };
  }

  private fallback(enml: string, err: unknown): ConvertResult {
    const message = err instanceof Error ? err.message : String(err);
    this.warnings.add("conversion_failed", message);
    const blocks: PMNode[] = [];
    if (this.opts.sanitizeHtml) {
      try {
        blocks.push(this.clipNode(this.opts.sanitizeHtml(enml)));
        this.stats.webClip = true;
      } catch {
        blocks.length = 0;
      }
    }
    if (!blocks.length) blocks.push(this.paragraph([this.t.unsupported.create({ raw: enml })]));
    const node = this.schema.node("doc", null, blocks);
    return { doc: docJson(node), node, warnings: this.warnings.list(), stats: this.stats };
  }

  private clipNode(sanitizedHtml: string): PMNode {
    const version = this.opts.sanitizerVersion === undefined ? SANITIZER_VERSION : this.opts.sanitizerVersion;
    return this.t.webClip.create({ html: sanitizedHtml, sanitizerVersion: version });
  }

  private blocks(children: readonly AnyNode[], ctx: Ctx): PMNode[] {
    const st: State = { run: [], out: [], align: ctx.align, indent: ctx.indent };
    this.walk(children, ctx, st);
    this.flush(st);
    return this.mergeTaskLists(st.out);
  }

  private walk(children: readonly AnyNode[], ctx: Ctx, st: State): void {
    for (const node of children) {
      if (isText(node)) this.text(node.data, ctx, st.run);
      else if (isCDATA(node)) this.walk(node.children, ctx, st);
      else if (isTag(node)) this.element(node, ctx, st);
    }
  }

  private element(el: Element, ctx: Ctx, st: State): void {
    const name = el.name;
    if (name === "br") {
      st.run.push(BR);
      return;
    }
    if (name === "en-media") {
      this.media(el, ctx, st.run);
      return;
    }
    if (name === "en-crypt") {
      this.crypt(el, ctx, st.run);
      return;
    }
    if (name === "en-todo") {
      st.run.push({ kind: "todo", checked: isTruthy(el.attribs.checked) });
      return;
    }
    if (name === "img") {
      this.image(el, ctx, st.run);
      return;
    }
    if (name === "a" || INLINE_TAGS.has(name)) {
      this.walk(el.children, name === "a" ? this.link(el, ctx) : this.withMarks(el, ctx), st);
      return;
    }
    if (DROPPED_TAGS.has(name)) {
      this.warnings.add("dropped_element", name);
      return;
    }
    if (BLOCK_TAGS.has(name)) {
      this.flush(st);
      this.block(el, ctx, st.out);
      return;
    }
    this.unsupported(el, ctx, st.run);
  }

  private block(el: Element, ctx: Ctx, out: PMNode[]): void {
    const name = el.name;
    const style = parseStyle(el.attribs.style);
    if (CODE_TAGS.has(name) || isTruthy(enProp(style, "codeblock"))) {
      out.push(...this.codeBlocks(codeText(el, CODE_TAGS.has(name))));
      return;
    }
    if (isTruthy(enProp(style, "task-group"))) {
      out.push(...this.taskGroup(el, style));
      return;
    }
    if (enProp(style, "clipped-content")) {
      const clipped = this.tryClip([el], serialize([el]).length, true);
      if (clipped) {
        out.push(...clipped);
        return;
      }
    }
    if (name === "hr") {
      out.push(this.t.horizontalRule.create());
      return;
    }
    this.blockFormatting(name, style);
    const marked = this.withMarks(el, ctx, style);
    if (LIST_TAGS.has(name)) {
      // A list's own nesting is its indent; its items keep the alignment around them.
      out.push(...this.list(el, { ...marked, indent: 0 }, style));
      return;
    }
    if (name === "table") {
      this.table(el, { ...marked, align: null, indent: 0 }, out);
      return;
    }
    const inner = this.blockAttrs(name, style, marked);
    if (name === "blockquote") {
      const content = this.blocks(el.children, inner);
      out.push(this.t.blockquote.create(null, content.length ? content : [this.paragraph([])]));
      return;
    }
    const heading = /^h([1-6])$/.exec(name);
    if (heading) {
      const level = Number(heading[1]);
      for (const b of this.blocks(el.children, inner)) {
        const attrs = { level, textAlign: b.attrs.textAlign ?? null, indent: b.attrs.indent ?? 0 };
        out.push(b.type.name === "paragraph" ? this.t.heading.create(attrs, b.content) : b);
      }
      return;
    }
    const st: State = { run: [], out, align: inner.align, indent: inner.indent };
    this.walk(el.children, inner, st);
    this.flush(st);
  }

  /** Alignment and indent of a block element, on top of what it sits in (schema v3). */
  private blockAttrs(name: string, style: Map<string, string>, ctx: Ctx): Ctx {
    const raw = style.get("text-align");
    let align = ctx.align;
    if (raw !== undefined) align = parseAlignment(raw);
    else if (name === "center") align = "center";
    const steps = indentSteps(style.get("margin-left") ?? style.get("padding-left"));
    const indent = Math.min(MAX_INDENT, ctx.indent + steps);
    return align === ctx.align && indent === ctx.indent ? ctx : { ...ctx, align, indent };
  }

  private blockFormatting(name: string, style: Map<string, string>): void {
    if (backgroundColor(style) && !style.has("--en-highlight") && name !== "table")
      this.warnings.add("formatting_dropped", "background");
  }

  private text(data: string, ctx: Ctx, run: InlineItem[]): void {
    if (ctx.pre) {
      const lines = data.replace(/\r\n?/g, "\n").split("\n");
      lines.forEach((line, i) => {
        if (i > 0) run.push(BR);
        if (!line) return;
        const node = this.schema.text(line, ctx.marks);
        this.preserved.add(node);
        run.push(node);
      });
      return;
    }
    let t = data.replace(/[ \t\n\r\f]+/g, " ");
    if (t.startsWith(" ") && this.atLineStartOrSpace(run)) t = t.slice(1);
    if (t) run.push(this.schema.text(t, ctx.marks));
  }

  private atLineStartOrSpace(run: InlineItem[]): boolean {
    const item = run[run.length - 1];
    if (!item) return true;
    if (!("type" in item)) return item.kind === "br" || item.kind === "todo";
    return item.isText ? (item.text ?? "").endsWith(" ") : false;
  }

  private flush(st: State): void {
    const run = st.run;
    if (!run.length) return;
    st.run = [];
    const lines: InlineItem[][] = [[]];
    for (const item of run) {
      if (item === BR) lines.push([]);
      else (lines[lines.length - 1] as InlineItem[]).push(item);
    }
    // A trailing <br> ends the line it follows; it does not open a new one (`<div>text<br/></div>` is one line).
    if (lines.length > 1 && !hasContent(lines[lines.length - 1] as InlineItem[])) lines.pop();
    if (lines.length === 1 && !hasContent(lines[0] as InlineItem[]) && !run.includes(BR)) return;

    let para: PMNode[] | null = null;
    let tasks: PMNode[] = [];
    const closePara = () => {
      if (para) st.out.push(this.paragraph(para, st));
      para = null;
    };
    const closeTasks = () => {
      if (!tasks.length) return;
      const list = this.t.taskList.create(null, tasks);
      this.mergeable.add(list);
      st.out.push(list);
      tasks = [];
    };
    for (const line of lines) {
      const segments = splitAtTodos(line);
      const head = trimLine(segments.head, this.preserved);
      if (!segments.todos.length) {
        closeTasks();
        if (para) para.push(this.t.hardBreak.create());
        else para = [];
        para.push(...head);
        continue;
      }
      if (head.length) {
        closeTasks();
        if (para) para.push(this.t.hardBreak.create());
        else para = [];
        para.push(...head);
      }
      closePara();
      for (const todo of segments.todos) {
        tasks.push(
          this.t.taskItem.create({ checked: todo.checked }, [this.paragraph(trimLine(todo.content, this.preserved))]),
        );
      }
    }
    closePara();
    closeTasks();
  }

  private paragraph(content: PMNode[], st?: State): PMNode {
    const align = st?.align ?? null;
    const indent = st?.indent ?? 0;
    return this.t.paragraph.create(align || indent ? { textAlign: align, indent } : null, content);
  }

  private mergeTaskLists(blocks: PMNode[]): PMNode[] {
    const out: PMNode[] = [];
    for (const b of blocks) {
      const prev = out[out.length - 1];
      if (prev && this.mergeable.has(prev) && this.mergeable.has(b)) {
        const merged = this.t.taskList.create(null, prev.content.append(b.content));
        this.mergeable.add(merged);
        out[out.length - 1] = merged;
      } else out.push(b);
    }
    return out;
  }

  private withMarks(el: Element, ctx: Ctx, parsed?: Map<string, string>): Ctx {
    const style = parsed ?? parseStyle(el.attribs.style);
    let marks = ctx.marks;
    let pre = ctx.pre;
    switch (el.name) {
      case "b":
      case "strong":
        marks = this.addMark(marks, this.t.bold.create());
        break;
      case "i":
      case "em":
      case "cite":
      case "var":
      case "dfn":
        marks = this.addMark(marks, this.t.italic.create());
        break;
      case "u":
      case "ins":
        marks = this.addMark(marks, this.t.underline.create());
        break;
      case "s":
      case "strike":
      case "del":
        marks = this.addMark(marks, this.t.strike.create());
        break;
      case "code":
      case "tt":
      case "kbd":
      case "samp":
        marks = this.addMark(marks, this.t.code.create());
        break;
      case "mark":
        marks = this.addMark(marks, this.t.highlight.create({ color: null }));
        break;
      case "sub":
        marks = this.addMark(this.t.superscript.removeFromSet(marks), this.t.subscript.create());
        break;
      case "sup":
        marks = this.addMark(this.t.subscript.removeFromSet(marks), this.t.superscript.create());
        break;
      case "font": {
        const attrs = {
          color: cssColor(el.attribs.color, normalizeColor),
          fontFamily: cssFontFamily(el.attribs.face),
          fontSize: htmlFontSize(el.attribs.size),
        };
        marks = this.textStyle(marks, attrs);
        break;
      }
    }
    if (style.size) {
      const weight = style.get("font-weight")?.toLowerCase();
      if (weight && /^(bold|bolder|[6-9]00)$/.test(weight)) marks = this.addMark(marks, this.t.bold.create());
      else if (weight && /^(normal|lighter|[1-4]00)$/.test(weight)) marks = this.t.bold.removeFromSet(marks);
      const fontStyle = style.get("font-style")?.toLowerCase();
      if (fontStyle === "italic" || fontStyle === "oblique") marks = this.addMark(marks, this.t.italic.create());
      else if (fontStyle === "normal") marks = this.t.italic.removeFromSet(marks);
      const decoration =
        `${style.get("text-decoration") ?? ""} ${style.get("text-decoration-line") ?? ""}`.toLowerCase();
      if (decoration.includes("underline")) marks = this.addMark(marks, this.t.underline.create());
      if (decoration.includes("line-through")) marks = this.addMark(marks, this.t.strike.create());
      if (/\bnone\b/.test(decoration) && !decoration.includes("underline"))
        marks = this.t.underline.removeFromSet(this.t.strike.removeFromSet(marks));
      const valign = style.get("vertical-align")?.toLowerCase();
      if (valign === "sub") marks = this.addMark(this.t.superscript.removeFromSet(marks), this.t.subscript.create());
      else if (valign === "super")
        marks = this.addMark(this.t.subscript.removeFromSet(marks), this.t.superscript.create());
      const family = cssFontFamily(style.get("font-family"));
      const attrs = {
        color: cssColor(style.get("color"), normalizeColor),
        fontFamily: family,
        fontSize: cssFontSize(style.get("font-size")),
      };
      marks = this.textStyle(marks, attrs);
      const highlightName = style.get("--en-highlight");
      const isHighlight = highlightName !== undefined || isTruthy(enProp(style, "highlight"));
      const bg = cssColor(backgroundColor(style), normalizeColor);
      if (isHighlight || (bg && bg !== "#ffffff" && INLINE_TAGS.has(el.name))) {
        marks = this.addMark(marks, this.t.highlight.create({ color: bg ?? namedHighlight(highlightName) }));
      }
      const ws = style.get("white-space")?.toLowerCase();
      if (ws) pre = /^(pre|pre-wrap|break-spaces|pre-line)$/.test(ws);
    }
    return marks === ctx.marks && pre === ctx.pre ? ctx : { ...ctx, marks, pre };
  }

  private textStyle(
    marks: readonly Mark[],
    attrs: { color: string | null; fontFamily: string | null; fontSize: string | null },
  ): readonly Mark[] {
    if (attrs.color === null && attrs.fontFamily === null && attrs.fontSize === null) return marks;
    const type = this.t.textStyle;
    const existing = type.isInSet(marks);
    const merged = { ...(existing?.attrs ?? {}) };
    for (const [k, v] of Object.entries(attrs)) if (v !== null) merged[k] = v;
    return this.addMark(type.removeFromSet(marks), type.create(merged));
  }

  // `code` excludes every other mark in our schema; a link is data and wins over code formatting.
  private addMark(marks: readonly Mark[], mark: Mark): readonly Mark[] {
    const code = this.t.code;
    const link = this.t.link;
    if (mark.type === code && link.isInSet(marks)) {
      this.warnings.add("formatting_dropped", "code inside link");
      return marks;
    }
    if (mark.type === link && code.isInSet(marks)) return mark.addToSet(code.removeFromSet(marks));
    return mark.addToSet(marks);
  }

  private link(el: Element, ctx: Ctx): Ctx {
    const inner = this.withMarks(el, ctx);
    let href = (el.attribs.href ?? "").trim();
    if (!href || /^(javascript|vbscript|data):/i.test(href)) return inner;
    const resolution = this.opts.resolveLink?.(href, textContent(el)) ?? null;
    if (resolution?.kind === "resolved") {
      href = resolution.href;
      this.stats.linksResolved++;
      this.warnings.add("evernote_link_resolved", null);
    } else if (resolution?.kind === "unresolved") {
      this.stats.linksUnresolved++;
      this.warnings.add("evernote_link_unresolved", `${href} (${resolution.reason})`);
    }
    const mark = this.t.link.create({ href, title: el.attribs.title ?? null });
    return { ...inner, marks: this.addMark(inner.marks, mark) };
  }

  private media(el: Element, ctx: Ctx, run: InlineItem[]): void {
    this.stats.mediaRefs++;
    const hash = (el.attribs.hash ?? "").trim().toLowerCase();
    const resource = this.byMd5.get(hash);
    if (!resource) {
      this.stats.mediaMissing.push(hash);
      this.warnings.add("missing_resource", hash || "(no hash)");
      this.unsupported(el, ctx, run, false);
      return;
    }
    this.referenced.add(resource);
    const style = parseStyle(el.attribs.style);
    run.push(this.attachment(resource, attrPixels(el, "width", style), attrPixels(el, "height", style), ctx.marks));
  }

  private attachment(r: ConvertResource, width: number | null, height: number | null, marks: readonly Mark[]): PMNode {
    return this.t.attachment.create(
      {
        resourceId: r.resourceId,
        display: r.mime.toLowerCase().startsWith("image/") ? "inline" : "card",
        mime: r.mime,
        filename: r.filename,
        width,
        height,
      },
      null,
      marks,
    );
  }

  private crypt(el: Element, ctx: Ctx, run: InlineItem[]): void {
    this.stats.encrypted++;
    this.warnings.add("encrypted", el.attribs.hint ? `hint: ${el.attribs.hint}` : null);
    run.push(
      this.t.encrypted.create(
        {
          cipher: el.attribs.cipher || "RC2",
          length: clampInt(el.attribs.length, 1, 4096) ?? 64,
          hint: el.attribs.hint ?? null,
          ciphertext: textContent(el).replace(/\s+/g, ""),
        },
        null,
        ctx.marks,
      ),
    );
  }

  private image(el: Element, ctx: Ctx, run: InlineItem[]): void {
    const src = (el.attribs.src ?? "").trim();
    if (!src) {
      this.warnings.add("image_without_src", null);
      return;
    }
    if (/^data:/i.test(src)) {
      const decoded = decodeDataUri(src);
      const stored = decoded && this.opts.storeDataImage?.(decoded.mime, decoded.bytes);
      if (stored) {
        this.stats.dataImages++;
        this.warnings.add("data_image", stored.mime);
        const style = parseStyle(el.attribs.style);
        run.push(this.attachment(stored, attrPixels(el, "width", style), attrPixels(el, "height", style), ctx.marks));
        return;
      }
      this.unsupported(el, ctx, run, false);
      return;
    }
    if (/^https?:\/\//i.test(src)) {
      // Kept as a link to the remote image; nothing is fetched at import.
      this.warnings.add("remote_image", src.slice(0, 200));
      const style = parseStyle(el.attribs.style);
      run.push(
        this.t.image.create(
          {
            src,
            alt: el.attribs.alt || null,
            width: attrPixels(el, "width", style),
            height: attrPixels(el, "height", style),
          },
          null,
          ctx.marks,
        ),
      );
      return;
    }
    this.unsupported(el, ctx, run);
  }

  private unsupported(el: Element, ctx: Ctx, run: InlineItem[], warn = true): void {
    this.stats.unsupported++;
    if (warn) this.warnings.add("unsupported_element", el.name);
    run.push(this.t.unsupported.create({ raw: serialize([el]) }, null, ctx.marks));
  }

  private codeBlocks(text: string): PMNode[] {
    const type = this.t.codeBlock;
    const lines = text.split("\n");
    const chunks: string[] = [];
    let current: string[] = [];
    let chars = 0;
    const close = () => {
      if (!current.length) return;
      chunks.push(current.join("\n"));
      current = [];
      chars = 0;
    };
    for (const line of lines) {
      if (line.length > CODE_BLOCK_MAX_CHARS) {
        // A single giant line (minified code) becomes consecutive blocks of its own; joined, they are the line.
        close();
        for (let i = 0; i < line.length; i += CODE_BLOCK_MAX_CHARS)
          chunks.push(line.slice(i, i + CODE_BLOCK_MAX_CHARS));
        continue;
      }
      if (current.length >= CODE_BLOCK_MAX_LINES || chars + line.length > CODE_BLOCK_MAX_CHARS) close();
      current.push(line);
      chars += line.length + 1;
    }
    close();
    if (!chunks.length) chunks.push("");
    if (chunks.length > 1) {
      this.stats.codeBlocksSplit++;
      this.warnings.add("code_block_split", `${lines.length} lines into ${chunks.length} blocks`);
    }
    return chunks.map((c) => type.create({ language: null }, c ? this.schema.text(c) : null));
  }

  private list(el: Element, ctx: Ctx, style: Map<string, string>): PMNode[] {
    const isTask = isTruthy(enProp(style, "todo"));
    const items: { blocks: PMNode[]; checked: boolean }[] = [];
    for (const child of el.children) {
      if (isText(child) && isWhitespace(child.data)) continue;
      if (isTag(child) && child.name === "li") {
        const liStyle = parseStyle(child.attribs.style);
        const inner = this.withMarks(child, ctx, liStyle);
        items.push({ blocks: this.blocks(child.children, inner), checked: isTruthy(enProp(liStyle, "checked")) });
      } else if (isTag(child) && LIST_TAGS.has(child.name)) {
        // Lists nested directly in a list (no <li>) belong to the previous item.
        const nested: PMNode[] = [];
        this.block(child, ctx, nested);
        const last = items[items.length - 1];
        if (last) last.blocks.push(...nested);
        else items.push({ blocks: nested, checked: false });
      } else {
        const blocks = this.blocks([child], ctx);
        if (blocks.length) items.push({ blocks, checked: false });
      }
    }
    if (!items.length) return [];
    // Legacy checklists are lists whose every item starts with an <en-todo>: that is a task list.
    if (!isTask && items.every((it) => it.blocks[0] && this.mergeable.has(it.blocks[0]))) {
      const taskItems: PMNode[] = [];
      for (const it of items) {
        const [first, ...rest] = it.blocks as [PMNode, ...PMNode[]];
        const fromLine: PMNode[] = [];
        first.forEach((c) => {
          fromLine.push(c);
        });
        const last = fromLine.pop() as PMNode;
        fromLine.push(last.copy(last.content.append(Fragment.fromArray(rest))));
        taskItems.push(...fromLine);
      }
      return [this.t.taskList.create(null, taskItems)];
    }
    const itemType = isTask ? this.t.taskItem : this.t.listItem;
    const nodes = items.map((it) => {
      const content = it.blocks[0]?.type.name === "paragraph" ? it.blocks : [this.paragraph([]), ...it.blocks];
      return itemType.create(isTask ? { checked: it.checked } : null, content);
    });
    if (isTask) return [this.t.taskList.create(null, nodes)];
    if (el.name === "ol") {
      const start = clampInt(el.attribs.start, -1_000_000, 1_000_000) ?? 1;
      const type = /^[aAiI1]$/.test(el.attribs.type ?? "") ? (el.attribs.type as string) : null;
      return [this.t.orderedList.create({ start, type }, nodes)];
    }
    return [this.t.bulletList.create(null, nodes)];
  }

  private table(el: Element, ctx: Ctx, out: PMNode[]): void {
    const rows: Element[] = [];
    const extras: AnyNode[] = [];
    const collect = (parent: Element) => {
      for (const child of parent.children) {
        if (isText(child) && isWhitespace(child.data)) continue;
        if (!isTag(child)) {
          extras.push(child);
          continue;
        }
        if (child.name === "tr") rows.push(child);
        else if (child.name === "thead" || child.name === "tbody" || child.name === "tfoot") collect(child);
        else if (child.name === "caption") out.push(...this.blocks(child.children, ctx));
        else if (child.name !== "colgroup" && child.name !== "col") extras.push(child);
      }
    };
    collect(el);
    const rowNodes: PMNode[] = [];
    for (const tr of rows) {
      const cells: PMNode[] = [];
      for (const cell of tr.children) {
        if (isText(cell) && isWhitespace(cell.data)) continue;
        const isCell = isTag(cell) && (cell.name === "td" || cell.name === "th");
        const cellEl = isCell ? (cell as Element) : null;
        const style = cellEl ? parseStyle(cellEl.attribs.style) : new Map<string, string>();
        if (cellEl && backgroundColor(style)) this.warnings.add("formatting_dropped", "cell background");
        const inner = cellEl ? this.withMarks(cellEl, ctx, style) : ctx;
        const content = this.blocks(cellEl ? cellEl.children : [cell], inner);
        const colspan = clampInt(cellEl?.attribs.colspan, 1, 1000) ?? 1;
        const rowspan = clampInt(cellEl?.attribs.rowspan, 1, 65_534) ?? 1;
        const width = cellEl ? attrPixels(cellEl, "width", style) : null;
        const alignRaw = (style.get("text-align") ?? cellEl?.attribs.align ?? "").toLowerCase();
        const align = /^(left|center|right)$/.test(alignRaw) ? alignRaw : null;
        const type = cellEl?.name === "th" ? this.t.tableHeader : this.t.tableCell;
        cells.push(
          type.create(
            { colspan, rowspan, colwidth: width && colspan === 1 ? [width] : null, align },
            content.length ? content : [this.paragraph([])],
          ),
        );
      }
      if (cells.length) rowNodes.push(this.t.tableRow.create(null, cells));
    }
    if (rowNodes.length) out.push(this.t.table.create(null, rowNodes));
    if (extras.length) out.push(...this.blocks(extras, ctx));
  }

  private taskGroup(el: Element, style: Map<string, string>): PMNode[] {
    const id = enProp(style, "id")?.trim();
    const tasks = (this.opts.tasks ?? [])
      .filter((t) => id && t.groupId === id && !this.placedTasks.has(t))
      .sort((a, b) =>
        (a.sortWeight ?? "") < (b.sortWeight ?? "") ? -1 : (a.sortWeight ?? "") > (b.sortWeight ?? "") ? 1 : 0,
      );
    if (!tasks.length) {
      this.warnings.add("task_group_without_tasks", id ?? null);
      const holder: InlineItem[] = [];
      this.unsupported(el, { marks: [], pre: false, align: null, indent: 0 }, holder, false);
      return [this.paragraph(holder as PMNode[])];
    }
    return [this.taskList(tasks)];
  }

  private taskList(tasks: readonly ConvertTask[]): PMNode {
    for (const t of tasks) this.placedTasks.add(t);
    this.stats.tasks += tasks.length;
    this.warnings.add("tasks", null, tasks.length);
    return this.t.taskList.create(
      null,
      tasks.map((t) =>
        this.t.taskItem.create(
          {
            checked: t.status === "completed",
            taskId: this.taskId(t),
            due: t.dueDate && Number.isFinite(t.dueDate.getTime()) ? t.dueDate.toISOString() : null,
            flagged: t.flag === true,
          },
          [this.paragraph(t.title.trim() ? [this.schema.text(t.title.trim())] : [])],
        ),
      ),
    );
  }

  // Ids must be unique within the note (a duplicate would make two items one task) and stable across retries.
  private taskId(task: ConvertTask): string {
    let id = task.id?.trim() || null;
    if (!id || this.taskIds.has(id)) {
      const index = (this.opts.tasks ?? []).indexOf(task);
      id = `imported-${index + 1}`;
      for (let n = 2; this.taskIds.has(id); n++) id = `imported-${index + 1}-${n}`;
    }
    this.taskIds.add(id);
    return id;
  }

  private unplacedTasks(): PMNode[] {
    const rest = (this.opts.tasks ?? []).filter((t) => !this.placedTasks.has(t));
    if (!rest.length) return [];
    this.warnings.add("tasks_unplaced", null, rest.length);
    return [this.taskList(rest)];
  }

  private unreferencedResources(): PMNode[] {
    const out: PMNode[] = [];
    const seen = new Set<string>();
    for (const r of this.opts.resources ?? []) {
      if (this.referenced.has(r) || seen.has(r.resourceId)) continue;
      // A second resource with the same bytes as a referenced one is a duplicate, not a lost attachment.
      const twin = this.byMd5.get(r.md5.toLowerCase());
      if (twin && twin !== r && this.referenced.has(twin)) continue;
      seen.add(r.resourceId);
      this.stats.unreferencedResources++;
      this.warnings.add("unreferenced_resource", r.filename ?? r.mime);
      out.push(this.paragraph([this.attachment({ ...r, mime: r.mime }, null, null, [])]));
      this.referenced.add(r);
    }
    return out;
  }

  private tryClip(nodes: readonly AnyNode[], size: number, wrapper: boolean): PMNode[] | null {
    const sanitize = this.opts.sanitizeHtml;
    if (!sanitize) return null;
    const metrics = measureClip(nodes);
    if (metrics.crypt || !shouldPreserveAsClip(metrics, size, this.clip, wrapper)) return null;
    const html = serialize(nodes, (el) => this.clipRewrite(el));
    const clean = sanitize(html);
    this.stats.webClip = true;
    this.warnings.add("web_clip", `${Math.round(size / 1024)} KB, ${metrics.elements} elements`);
    return [this.clipNode(clean)];
  }

  private clipRewrite(el: Element): ReturnType<Rewrite> {
    if (el.name === "en-note") return { name: "div", attribs: {} };
    if (el.name === "en-todo") {
      const attribs: Record<string, string> = { type: "checkbox", disabled: "" };
      if (isTruthy(el.attribs.checked)) attribs.checked = "";
      return { name: "input", attribs };
    }
    if (el.name === "en-media") {
      this.stats.mediaRefs++;
      const hash = (el.attribs.hash ?? "").trim().toLowerCase();
      const r = this.byMd5.get(hash);
      if (!r) {
        this.stats.mediaMissing.push(hash);
        this.warnings.add("missing_resource", hash || "(no hash)");
        return { name: "span", attribs: { "data-missing-resource": hash }, text: "" };
      }
      this.referenced.add(r);
      const style = parseStyle(el.attribs.style);
      const w = attrPixels(el, "width", style);
      const h = attrPixels(el, "height", style);
      const size: Record<string, string> = {};
      if (w) size.width = String(w);
      if (h) size.height = String(h);
      if (r.mime.toLowerCase().startsWith("image/"))
        return { name: "img", attribs: { "data-resource-id": r.resourceId, alt: r.filename ?? "", ...size } };
      return {
        name: "span",
        attribs: { "data-resource-id": r.resourceId, "data-mime": r.mime },
        text: `[${r.filename ?? r.mime}]`,
      };
    }
    if (el.name === "a" && el.attribs.href) {
      const resolution = this.opts.resolveLink?.(el.attribs.href, textContent(el)) ?? null;
      if (resolution?.kind === "resolved") {
        this.stats.linksResolved++;
        this.warnings.add("evernote_link_resolved", null);
        return { name: "a", attribs: { ...el.attribs, href: resolution.href } };
      }
      if (resolution?.kind === "unresolved") {
        this.stats.linksUnresolved++;
        this.warnings.add("evernote_link_unresolved", `${el.attribs.href} (${resolution.reason})`);
      }
    }
    return null;
  }
}

type SchemaTypes = ReturnType<typeof resolveTypes>;
let types: SchemaTypes | null = null;

function schemaTypes(): SchemaTypes {
  types ??= resolveTypes(getEditorSchema());
  return types;
}

// Resolved once and checked, so a schema change that drops a type fails loudly instead of at some later note.
function resolveTypes(schema: Schema) {
  const node = (name: string): NodeType => {
    const t = schema.nodes[name];
    if (!t) throw new Error(`editor schema has no node "${name}"`);
    return t;
  };
  const mark = (name: string): MarkType => {
    const t = schema.marks[name];
    if (!t) throw new Error(`editor schema has no mark "${name}"`);
    return t;
  };
  return {
    paragraph: node("paragraph"),
    heading: node("heading"),
    blockquote: node("blockquote"),
    horizontalRule: node("horizontalRule"),
    hardBreak: node("hardBreak"),
    bulletList: node("bulletList"),
    orderedList: node("orderedList"),
    listItem: node("listItem"),
    taskList: node("taskList"),
    taskItem: node("taskItem"),
    codeBlock: node("codeBlock"),
    table: node("table"),
    tableRow: node("tableRow"),
    tableHeader: node("tableHeader"),
    tableCell: node("tableCell"),
    attachment: node("attachment"),
    image: node("image"),
    encrypted: node("encrypted"),
    unsupported: node("unsupported"),
    webClip: node("webClip"),
    bold: mark("bold"),
    italic: mark("italic"),
    underline: mark("underline"),
    strike: mark("strike"),
    code: mark("code"),
    link: mark("link"),
    textStyle: mark("textStyle"),
    highlight: mark("highlight"),
    subscript: mark("subscript"),
    superscript: mark("superscript"),
  };
}

function namedHighlight(name: string | undefined): string | null {
  // Our own marker colors for exports that name a highlight without giving its color.
  const map: Record<string, string> = {
    yellow: "#fff59d",
    red: "#ffcdd2",
    green: "#c8e6c9",
    blue: "#bbdefb",
    purple: "#e1bee7",
    orange: "#ffe0b2",
    pink: "#f8bbd0",
  };
  return name ? (map[name.trim().toLowerCase()] ?? null) : null;
}

function hasContent(items: InlineItem[]): boolean {
  return items.some((i) => "type" in i || i.kind === "todo");
}

function splitAtTodos(line: InlineItem[]): { head: PMNode[]; todos: { checked: boolean; content: PMNode[] }[] } {
  const head: PMNode[] = [];
  const todos: { checked: boolean; content: PMNode[] }[] = [];
  for (const item of line) {
    if ("type" in item) (todos.length ? (todos[todos.length - 1] as { content: PMNode[] }).content : head).push(item);
    else if (item.kind === "todo") todos.push({ checked: item.checked, content: [] });
  }
  // Text before the first checkbox that is only whitespace does not make its own paragraph.
  if (todos.length && head.every((n) => n.isText && !(n.text ?? "").trim())) head.length = 0;
  return { head, todos };
}

// Removes the collapsible spaces HTML would not render at the start and end of a line.
function trimLine(nodes: PMNode[], preserved: WeakSet<PMNode>): PMNode[] {
  const out = [...nodes];
  const first = out[0];
  if (first?.isText && !preserved.has(first)) {
    const t = (first.text ?? "").replace(/^ +/, "");
    if (t) out[0] = first.type.schema.text(t, first.marks);
    else out.shift();
  }
  const last = out[out.length - 1];
  if (last?.isText && !preserved.has(last)) {
    const t = (last.text ?? "").replace(/ +$/, "");
    if (t) out[out.length - 1] = last.type.schema.text(t, last.marks);
    else out.pop();
  }
  return out;
}

// Line-oriented text of an Evernote code block (one div per line) or a <pre>.
function codeText(el: Element, pre: boolean): string {
  const lines: string[] = [];
  let cur = "";
  let open = false;
  const pushLine = () => {
    lines.push(cur);
    cur = "";
    open = false;
  };
  const hasBlockChildren = (n: Element) => n.children.some((c) => isTag(c) && BLOCK_TAGS.has(c.name));
  const walk = (node: AnyNode, parent: Element) => {
    if (isText(node)) {
      if (!pre && isWhitespace(node.data) && node.data.includes("\n") && hasBlockChildren(parent)) return;
      const parts = node.data.replace(/\r\n?/g, "\n").replace(/ /g, " ").split("\n");
      parts.forEach((p, i) => {
        if (i > 0) pushLine();
        cur += p;
        open = true;
      });
    } else if (isCDATA(node)) for (const c of node.children) walk(c, parent);
    else if (isTag(node)) {
      if (node.name === "br") {
        pushLine();
        return;
      }
      const block = BLOCK_TAGS.has(node.name);
      if (block && open && cur !== "") pushLine();
      for (const c of node.children) walk(c, node);
      if (block && open && cur !== "") pushLine();
    }
  };
  for (const c of el.children) walk(c, el);
  if (cur !== "") pushLine();
  // <pre> ignores one newline right after the opening tag.
  if (pre && lines[0] === "" && lines.length > 1) lines.shift();
  while (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}
