import { type AnyNode, type Element, isCDATA, isTag, isText } from "domhandler";
import { parseDocument } from "htmlparser2";
import { escapeAttr, escapeText } from "./xml.ts";

// HTML fragments we store (unsupported elements' raw ENML, web clip HTML) parsed the way `packages/enml` parses
// ENML, and written back as XML (void elements self-closed, everything escaped) so the result is well-formed ENML.

export const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
  "en-media",
  "en-todo",
]);

export function parseFragment(html: string): AnyNode[] {
  return parseDocument(html, {
    xmlMode: false,
    decodeEntities: true,
    lowerCaseTags: true,
    lowerCaseAttributeNames: true,
    recognizeSelfClosing: true,
    recognizeCDATA: true,
  }).children;
}

/** What to write for an element: another name and attributes, `drop` (with its content), or `unwrap` (content only). */
export type XmlRewrite = (
  el: Element,
) => { name: string; attribs: Record<string, string> } | "drop" | "unwrap" | { raw: string } | null;

const XML_NAME = /^[a-z_][a-z0-9_.:-]*$/i;

export function toXml(nodes: readonly AnyNode[], rewrite?: XmlRewrite): string {
  const out: string[] = [];
  const walk = (node: AnyNode): void => {
    if (isText(node)) out.push(escapeText(node.data));
    else if (isCDATA(node)) for (const c of node.children) walk(c);
    else if (isTag(node)) {
      const mapped = rewrite?.(node) ?? null;
      if (mapped === "drop") return;
      if (mapped === "unwrap") {
        for (const c of node.children) walk(c);
        return;
      }
      if (mapped && "raw" in mapped) {
        out.push(mapped.raw);
        return;
      }
      const name = mapped?.name ?? node.name;
      if (!XML_NAME.test(name)) {
        for (const c of node.children) walk(c);
        return;
      }
      const attrs = Object.entries(mapped?.attribs ?? node.attribs)
        .filter(([k]) => XML_NAME.test(k))
        .map(([k, v]) => ` ${k}="${escapeAttr(v)}"`)
        .join("");
      if (VOID.has(name)) {
        out.push(`<${name}${attrs}/>`);
        return;
      }
      out.push(`<${name}${attrs}>`);
      for (const c of node.children) walk(c);
      out.push(`</${name}>`);
    }
    // Comments, processing instructions and doctypes carry no content.
  };
  for (const n of nodes) walk(n);
  return out.join("");
}

export function textOf(nodes: readonly AnyNode[]): string {
  let out = "";
  const walk = (n: AnyNode) => {
    if (isText(n)) out += n.data;
    else if ("children" in n) for (const c of n.children) walk(c);
  };
  for (const n of nodes) walk(n);
  return out;
}

/** The visible text of an HTML fragment, whitespace collapsed (for places a fragment can't be shown as markup). */
export function fragmentText(html: string): string {
  return textOf(parseFragment(html)).replace(/\s+/g, " ").trim();
}
