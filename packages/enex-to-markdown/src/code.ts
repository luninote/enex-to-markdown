import type { DocNode } from "@luninote/export";
import { type AnyNode, type Element, isTag } from "domhandler";
import { parseDocument } from "htmlparser2";

// The language of a code block, which the shared converter doesn't carry over: a code block div says it in its style
// (`--en-syntaxLanguage: python`), a <pre> from a web page in a class (`language-python`, `lang-python`). Languages
// are matched to the converted blocks by order, and only when both sides count the same blocks.

const CODE_TAGS = new Set(["pre", "xmp", "listing", "plaintext"]);
const LANG = /^[\w+#.-]{1,40}$/;

const styleProp = (style: string | undefined, name: string) =>
  new RegExp(`(?:^|;)\\s*-{1,2}en-${name}\\s*:\\s*([^;]*)`, "i").exec(style ?? "")?.[1]?.trim() ?? null;

function classLanguage(el: Element): string | null {
  for (const node of [el, ...el.children.filter(isTag)]) {
    const m = /(?:^|\s)(?:language|lang)-([\w+#.-]+)/i.exec(node.attribs.class ?? "");
    if (m) return m[1] as string;
  }
  return null;
}

/** The language of each code block in the ENML, in document order (null where none is named). */
export function codeLanguages(enml: string): (string | null)[] {
  if (!/codeblock|<pre|<xmp|<listing|<plaintext/i.test(enml)) return [];
  const out: (string | null)[] = [];
  const walk = (nodes: AnyNode[]) => {
    for (const n of nodes) {
      if (!isTag(n)) continue;
      const style = n.attribs.style;
      if (CODE_TAGS.has(n.name) || /^\s*true\s*$/i.test(styleProp(style, "codeblock") ?? "")) {
        const lang = styleProp(style, "syntaxLanguage") ?? classLanguage(n);
        out.push(lang && LANG.test(lang) ? lang.toLowerCase() : null);
        continue;
      }
      walk(n.children);
    }
  };
  walk(parseDocument(enml, { xmlMode: false, decodeEntities: true, lowerCaseTags: true }).children);
  return out;
}

/** Sets `language` on the document's code blocks from `languages`, when the counts agree. */
export function applyCodeLanguages(doc: DocNode, languages: readonly (string | null)[]): void {
  if (!languages.some(Boolean)) return;
  const blocks: DocNode[] = [];
  const walk = (n: DocNode) => {
    if (n.type === "codeBlock") blocks.push(n);
    for (const c of n.content ?? []) walk(c);
  };
  walk(doc);
  if (blocks.length !== languages.length) return;
  blocks.forEach((b, i) => {
    const lang = languages[i];
    if (lang) b.attrs = { ...b.attrs, language: lang };
  });
}
