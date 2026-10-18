import { type AnyNode, type Element, isCDATA, isComment, isDirective, isTag, isText } from "domhandler";

const VOID = new Set([
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
]);

const escapeText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export type Rewrite = (el: Element) => { name: string; attribs: Record<string, string>; text?: string } | null;

export function serialize(nodes: readonly AnyNode[], rewrite?: Rewrite): string {
  const out: string[] = [];
  const walk = (node: AnyNode): void => {
    if (isText(node)) out.push(escapeText(node.data));
    else if (isCDATA(node)) for (const c of node.children) walk(c);
    else if (isTag(node)) {
      const mapped = rewrite?.(node) ?? null;
      const name = mapped?.name ?? node.name;
      const attribs = mapped?.attribs ?? node.attribs;
      const attrs = Object.entries(attribs)
        .map(([k, v]) => (v === "" ? ` ${k}` : ` ${k}="${escapeAttr(v)}"`))
        .join("");
      out.push(`<${name}${attrs}>`);
      if (VOID.has(name)) return;
      if (mapped?.text !== undefined) out.push(escapeText(mapped.text));
      else if (!mapped || mapped.name === node.name || !node.name.startsWith("en-"))
        for (const c of node.children) walk(c);
      out.push(`</${name}>`);
    } else if (isComment(node) || isDirective(node)) {
      // Dropped: comments and processing instructions carry no content.
    } else if ("children" in node) for (const c of node.children) walk(c);
  };
  for (const n of nodes) walk(n);
  return out.join("");
}

export function textContent(node: AnyNode): string {
  if (isText(node)) return node.data;
  if ("children" in node) return node.children.map(textContent).join("");
  return "";
}
