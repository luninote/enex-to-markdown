import sax from "sax";

export interface RecoIndex {
  /** Best candidate per recognized item, in reading order: words on a line joined by spaces, lines by newlines. */
  text: string;
  items: number;
  docType: string | null;
  objType: string | null;
  lang: string | null;
}

interface Item {
  x: number;
  y: number;
  w: number;
  h: number;
  best: string;
  bestWeight: number;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Reads Evernote's recognition XML (recoIndex.dtd). Each `item` has text candidates `t` with a confidence `w`
 * (0–100); we keep the highest one. Throws on XML that cannot be read at all, so the caller can report it.
 */
export function parseRecoIndex(xml: string): RecoIndex {
  const parser = sax.parser(true, { trim: false, normalize: false, position: false });
  const items: Item[] = [];
  let item: Item | null = null;
  let candidate: { weight: number; text: string } | null = null;
  const meta = { docType: null as string | null, objType: null as string | null, lang: null as string | null };
  let errors = 0;

  parser.onerror = () => {
    errors++;
    parser.resume();
  };
  parser.onopentag = (node) => {
    const a = node.attributes as Record<string, string>;
    if (node.name === "recoIndex") {
      meta.docType = a.docType ?? null;
      meta.objType = a.objType ?? null;
      meta.lang = a.lang ?? null;
    } else if (node.name === "item") {
      item = { x: num(a.x), y: num(a.y), w: num(a.w), h: num(a.h), best: "", bestWeight: -1 };
    } else if (node.name === "t" && item) {
      candidate = { weight: num(a.w), text: "" };
    }
  };
  parser.ontext = (t) => {
    if (candidate) candidate.text += t;
  };
  parser.oncdata = (t) => {
    if (candidate) candidate.text += t;
  };
  parser.onclosetag = (name) => {
    if (name === "t" && item && candidate) {
      const text = candidate.text.replace(/\s+/g, " ").trim();
      if (text && candidate.weight > item.bestWeight) {
        item.best = text;
        item.bestWeight = candidate.weight;
      }
      candidate = null;
    } else if (name === "item" && item) {
      if (item.best) items.push(item);
      item = null;
    }
  };
  parser.write(xml.replace(/^\s*<!DOCTYPE[^>]*>/im, "")).close();
  if (errors && !items.length && !meta.objType) throw new Error("unreadable recognition data");
  return { text: readingOrder(items), items: items.length, ...meta };
}

// Items arrive in engine order, not reading order: group them into lines by vertical overlap, then left to right.
function readingOrder(items: Item[]): string {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: { top: number; bottom: number; items: Item[] }[] = [];
  for (const it of sorted) {
    const center = it.y + it.h / 2;
    const line = lines.find((l) => center >= l.top && center <= l.bottom);
    if (line) {
      line.items.push(it);
      line.top = Math.min(line.top, it.y);
      line.bottom = Math.max(line.bottom, it.y + it.h);
    } else {
      lines.push({ top: it.y, bottom: it.y + Math.max(1, it.h), items: [it] });
    }
  }
  lines.sort((a, b) => a.top - b.top);
  return lines
    .map((l) =>
      l.items
        .sort((a, b) => a.x - b.x)
        .map((i) => i.best)
        .join(" "),
    )
    .join("\n");
}
