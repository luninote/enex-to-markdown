import { type AnyNode, isTag } from "domhandler";
import { parseStyle } from "./css.ts";

/**
 * A page layout converted into paragraphs loses its layout and becomes thousands of near-empty blocks, so such
 * notes keep their sanitized HTML until the user converts them. Style density alone is not a signal: a long note
 * with many highlights is still the user's own text. Notes with `en-crypt` are never kept as clips: the encrypted
 * node must stay a node.
 */
export interface ClipThresholds {
  minElements: number;
  wrapperMinElements: number;
  deepNesting: number;
  layoutCss: number;
  largeBytes: number;
  largeStyledRatio: number;
  hugeBytes: number;
}

export const DEFAULT_CLIP_THRESHOLDS: ClipThresholds = {
  minElements: 150,
  wrapperMinElements: 40,
  deepNesting: 14,
  layoutCss: 6,
  largeBytes: 512 * 1024,
  largeStyledRatio: 0.3,
  hugeBytes: 2 * 1024 * 1024,
};

export interface ClipMetrics {
  elements: number;
  styled: number;
  maxDepth: number;
  layoutCss: number;
  nestedTables: number;
  crypt: boolean;
}

const LAYOUT =
  /(^|;)\s*(float\s*:\s*(left|right)|position\s*:\s*(absolute|fixed|relative)|display\s*:\s*(flex|inline-flex|grid|inline-block|table))/i;

export function measureClip(nodes: readonly AnyNode[]): ClipMetrics {
  const m: ClipMetrics = { elements: 0, styled: 0, maxDepth: 0, layoutCss: 0, nestedTables: 0, crypt: false };
  const walk = (node: AnyNode, depth: number, tables: number) => {
    if (!isTag(node)) return;
    m.elements++;
    if (depth > m.maxDepth) m.maxDepth = depth;
    if (node.name === "en-crypt") m.crypt = true;
    const style = node.attribs.style;
    if (style && parseStyle(style).size) {
      m.styled++;
      if (LAYOUT.test(style)) m.layoutCss++;
    }
    const inTable = node.name === "table" ? tables + 1 : tables;
    if (node.name === "table" && tables > 0) m.nestedTables++;
    for (const c of node.children) walk(c, depth + 1, inTable);
  };
  for (const n of nodes) walk(n, 1, 0);
  return m;
}

export function shouldPreserveAsClip(m: ClipMetrics, size: number, t: ClipThresholds, wrapper: boolean): boolean {
  if (m.crypt) return false;
  if (size > t.hugeBytes) return true;
  if (size > t.largeBytes && m.elements && m.styled / m.elements >= t.largeStyledRatio) return true;
  if (m.elements < (wrapper ? t.wrapperMinElements : t.minElements)) return false;
  return m.maxDepth >= t.deepNesting || m.layoutCss >= t.layoutCss || m.nestedTables > 0;
}
