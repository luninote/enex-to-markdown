import { Extension, Mark } from "@tiptap/core";

// Alignment and indent are left out of stored JSON at their default (content.ts), so v2 documents stay
// byte-identical.

export const ALIGNMENTS = ["left", "center", "right", "justify"] as const;
export type Alignment = (typeof ALIGNMENTS)[number];
export const MAX_INDENT = 8;
const BLOCKS = ["paragraph", "heading"];
/** One indent step on screen; ENML writes it as 40px. */
export const INDENT_EM = 2;
export const INDENT_PX = 40;

export function parseAlignment(value: string | null | undefined): Alignment | null {
  const v = value?.trim().toLowerCase();
  if (v === "center" || v === "right" || v === "justify") return v;
  if (v === "end") return "right";
  // Left is the default; storing it would make "left" and nothing differ.
  return null;
}

/** A CSS length (px, pt, em, rem) as indent steps, 0 to MAX_INDENT; anything else is 0. */
export function indentSteps(value: string | null | undefined): number {
  const m = /^\s*([\d.]+)\s*(px|pt|em|rem)\s*$/i.exec(value ?? "");
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = (m[2] as string).toLowerCase();
  const px = unit === "px" ? n : unit === "pt" ? (n * 4) / 3 : n * 16;
  if (!(px > 0)) return 0;
  return Math.min(MAX_INDENT, Math.max(1, Math.round(px / INDENT_PX)));
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    blockFormat: {
      setTextAlign: (alignment: Alignment | null) => ReturnType;
      indentBlock: () => ReturnType;
      outdentBlock: () => ReturnType;
    };
    subscript: { toggleSubscript: () => ReturnType };
    superscript: { toggleSuperscript: () => ReturnType };
  }
}

export const BlockFormat = Extension.create({
  name: "blockFormat",

  addGlobalAttributes() {
    return [
      {
        types: BLOCKS,
        attributes: {
          textAlign: {
            default: null,
            parseHTML: (el) => parseAlignment(el.style.textAlign || el.getAttribute("align")),
            renderHTML: (attrs) => (attrs.textAlign ? { style: `text-align: ${attrs.textAlign}` } : {}),
          },
          indent: {
            default: 0,
            parseHTML: (el) => {
              const data = Number(el.getAttribute("data-indent"));
              if (Number.isInteger(data) && data > 0) return Math.min(MAX_INDENT, data);
              return indentSteps(el.style.marginLeft || el.style.paddingLeft);
            },
            renderHTML: (attrs) =>
              attrs.indent > 0
                ? { "data-indent": String(attrs.indent), style: `margin-left: ${attrs.indent * INDENT_EM}em` }
                : {},
          },
        },
      },
    ];
  },

  addCommands() {
    const shift =
      (delta: number) =>
      () =>
      ({
        tr,
        state,
        dispatch,
      }: {
        tr: import("@tiptap/pm/state").Transaction;
        state: import("@tiptap/pm/state").EditorState;
        dispatch?: unknown;
      }) => {
        let changed = false;
        state.doc.nodesBetween(state.selection.from, state.selection.to, (node, pos) => {
          if (!BLOCKS.includes(node.type.name)) return true;
          const next = Math.min(MAX_INDENT, Math.max(0, (node.attrs.indent as number) + delta));
          if (next !== node.attrs.indent) {
            tr.setNodeAttribute(pos, "indent", next);
            changed = true;
          }
          return false;
        });
        if (changed && dispatch) return true;
        return changed;
      };
    return {
      setTextAlign:
        (alignment) =>
        ({ commands }) =>
          BLOCKS.map((type) =>
            commands.updateAttributes(type, { textAlign: alignment === "left" ? null : alignment }),
          ).some(Boolean),
      indentBlock: shift(1),
      outdentBlock: shift(-1),
    };
  },
});

export const Subscript = Mark.create({
  name: "subscript",
  excludes: "superscript",
  parseHTML: () => [{ tag: "sub" }, { style: "vertical-align", getAttrs: (v) => (v === "sub" ? null : false) }],
  renderHTML: () => ["sub", 0],
  addCommands() {
    return {
      toggleSubscript:
        () =>
        ({ commands }) =>
          commands.toggleMark(this.name),
    };
  },
});

export const Superscript = Mark.create({
  name: "superscript",
  excludes: "subscript",
  parseHTML: () => [{ tag: "sup" }, { style: "vertical-align", getAttrs: (v) => (v === "super" ? null : false) }],
  renderHTML: () => ["sup", 0],
  addCommands() {
    return {
      toggleSuperscript:
        () =>
        ({ commands }) =>
          commands.toggleMark(this.name),
    };
  },
});
