import type { AnyNode, Element } from "domhandler";
import { noteLinkTarget } from "./doc.ts";
import { parseFragment, textOf, toXml, type XmlRewrite } from "./markup.ts";

// Web clip HTML back to ENML. A clip holds sanitized HTML in which the importer replaced Evernote's own elements
// (en-media became <img data-resource-id> or <span data-resource-id>, en-todo a disabled checkbox); this undoes those
// replacements, so a re-import produces the same clip, and removes what ENML doesn't allow (Evernote's published
// ENML rules: no scripts, forms, frames or embedded objects; no id, class, event-handler, accesskey, data or
// tabindex attributes). HTML5 elements ENML predates become div or span, so their text stays.

// ENML's element set (XHTML 1.0 Transitional minus the prohibited ones), plus Evernote's own three.
const ENML_ELEMENTS = new Set(
  (
    "a abbr acronym address area b bdo big blockquote br caption center cite code col colgroup dd del dfn div dl dt " +
    "em font h1 h2 h3 h4 h5 h6 hr i img ins kbd li map ol p pre q s samp small span strike strong sub sup table tbody " +
    "td tfoot th thead tr tt u ul var xmp en-media en-crypt en-todo"
  ).split(" "),
);

// Gone with their content: code, styles, embedded and interactive things that have no meaning in a note.
const DROPPED = new Set(
  (
    "script style noscript head title meta link base basefont bgsound template iframe frame frameset noframes object " +
    "embed applet param select option optgroup datalist textarea input audio video canvas svg math source track " +
    "isindex xml portal dialog"
  ).split(" "),
);

const AS_DIV = new Set(
  (
    "section article header footer nav aside main figure figcaption details summary form fieldset legend hgroup " +
    "body html address search"
  ).split(" "),
);
const AS_LIST = new Set(["menu", "dir"]);

const PROHIBITED_ATTR = /^(id|class|accesskey|data|dynsrc|tabindex|on.*|data-.*|xmlns.*)$/;

export interface ClipEnmlContext {
  resource(resourceId: string): { md5: string; mime: string } | null;
  noteLink?(noteId: string): string | null;
}

export interface ClipEnml {
  enml: string;
  /** Resource ids the clip shows, in order. */
  resourceIds: string[];
  missing: string[];
  /** Whether the HTML is one `--en-clipped-content` wrapper element (a modern clip as Evernote writes it). */
  wrapped: boolean;
  nodes: AnyNode[];
}

const safeUrl = (v: string) => !/^\s*(javascript|vbscript|data:text\/html)/i.test(v);

export function clipToEnml(html: string, ctx: ClipEnmlContext): ClipEnml {
  const nodes = parseFragment(html);
  const resourceIds: string[] = [];
  const missing: string[] = [];
  const media = (el: Element, id: string): ReturnType<XmlRewrite> => {
    const r = ctx.resource(id);
    if (!r) {
      missing.push(id);
      return "drop";
    }
    if (!resourceIds.includes(id)) resourceIds.push(id);
    const attribs: Record<string, string> = { hash: r.md5, type: r.mime };
    if (el.attribs.width) attribs.width = el.attribs.width;
    if (el.attribs.height) attribs.height = el.attribs.height;
    return { name: "en-media", attribs };
  };
  const rewrite: XmlRewrite = (el) => {
    const name = el.name;
    const resourceId = el.attribs["data-resource-id"];
    if (resourceId !== undefined && (name === "img" || name === "span")) return media(el, resourceId);
    if (name === "span" && el.attribs["data-missing-resource"] !== undefined)
      return {
        name: "en-media",
        attribs: { hash: el.attribs["data-missing-resource"] ?? "", type: "application/octet-stream" },
      };
    if (name === "input" && (el.attribs.type ?? "").toLowerCase() === "checkbox") {
      return { name: "en-todo", attribs: el.attribs.checked !== undefined ? { checked: "true" } : {} };
    }
    if (DROPPED.has(name)) return "drop";
    const attribs = cleanAttributes(el, ctx);
    if (ENML_ELEMENTS.has(name)) return { name, attribs };
    if (AS_LIST.has(name)) return { name: "ul", attribs };
    if (AS_DIV.has(name)) return { name: "div", attribs };
    if (name === "picture" || name === "wbr") return name === "wbr" ? "drop" : "unwrap";
    return { name: "span", attribs };
  };
  const enml = toXml(nodes, rewrite);
  const elements = nodes.filter((n) => n.type === "tag") as Element[];
  const loose = nodes.some((n) => n.type === "text" && textOf([n]).trim());
  const wrapped =
    elements.length === 1 &&
    !loose &&
    /--en-clipped-content|-en-clipped-content/i.test(elements[0]?.attribs.style ?? "");
  return { enml, resourceIds, missing, wrapped, nodes };
}

function cleanAttributes(el: Element, ctx: ClipEnmlContext): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(el.attribs)) {
    if (PROHIBITED_ATTR.test(k)) continue;
    if ((k === "href" || k === "src" || k === "cite" || k === "longdesc") && !safeUrl(v)) continue;
    if (k === "href") {
      const target = noteLinkTarget(v);
      const href = target ? (ctx.noteLink?.(target) ?? v) : v;
      out[k] = href;
      continue;
    }
    out[k] = v;
  }
  return out;
}
