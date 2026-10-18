import { normalizeTitle, parseEvernoteLink } from "@luninote/enml";
import { type AnyNode, isTag, isText } from "domhandler";
import { parseDocument } from "htmlparser2";

// Links between notes. An ENEX file has no note ids (unless it was made with evernote-backup --add-guid), so a link
// is matched by its text, which Evernote sets to the target's title when the link is made. Tiers, first match wins:
//   guid       the export carries note GUIDs
//   title      exactly one note has the link text as its title
//   notebook   several do; exactly one is in the linking note's notebook
//   stack      ... exactly one is in the same input folder (stack)
//   other-link another link to the same Evernote note (same GUID in its address) matched one note by title
//   loose      exactly one title matches ignoring case, accents, spaces and punctuation (same narrowing)
//   fuzzy      opt-in: one clearly closest title
// Everything after `title` is reported, as is every link left pointing to Evernote.

export interface NoteRef {
  id: string;
  title: string;
  guid: string | null;
  /** Output folder of the notebook ("Stack/Notebook"); the parts of a split export share one. */
  notebook: string;
  /** Input folder the notebook's file was in ("Stack"), "" at the top. */
  stack: string;
  /** Path of the Markdown file, relative to the output folder. */
  path: string;
}

export type LinkHow = "guid" | "title" | "notebook" | "stack" | "other-link" | "loose" | "fuzzy";

export type LinkMatch =
  | { ok: true; note: NoteRef; how: LinkHow }
  | { ok: false; why: "ambiguous" | "missing" | "attachment"; candidates: NoteRef[] };

export interface LinkUse {
  href: string;
  text: string;
}

/** Title as compared in the loose tier: no case, accents, spaces or punctuation. */
export function looseKey(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function textOf(node: AnyNode): string {
  if (isText(node)) return node.data;
  if ("children" in node) return node.children.map(textOf).join("");
  return "";
}

/** The Evernote links in a note's ENML, with their text. */
export function evernoteLinks(enml: string): LinkUse[] {
  if (!/evernote/i.test(enml)) return [];
  const out: LinkUse[] = [];
  const walk = (nodes: AnyNode[]) => {
    for (const n of nodes) {
      if (!isTag(n)) continue;
      if (n.name === "a" && n.attribs.href && parseEvernoteLink(n.attribs.href)) {
        out.push({ href: n.attribs.href, text: textOf(n) });
        continue;
      }
      walk(n.children);
    }
  };
  walk(
    parseDocument(enml, { xmlMode: false, decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true })
      .children,
  );
  return out;
}

function push<K>(map: Map<K, NoteRef[]>, key: K, n: NoteRef): void {
  const list = map.get(key);
  if (list) list.push(n);
  else map.set(key, [n]);
}

/** Edit distance, or Infinity once it passes `max`. */
function distance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return Number.POSITIVE_INFINITY;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(
        (prev[j] as number) + 1,
        (cur[j - 1] as number) + 1,
        (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      cur.push(v);
      if (v < best) best = v;
    }
    if (best > max) return Number.POSITIVE_INFINITY;
    prev = cur;
  }
  return (prev[b.length] as number) <= max ? (prev[b.length] as number) : Number.POSITIVE_INFINITY;
}

type Narrowed = { note: NoteRef; how: LinkHow } | { ambiguous: NoteRef[] } | null;

export class LinkIndex {
  private readonly byGuid = new Map<string, NoteRef>();
  private readonly byTitle = new Map<string, NoteRef[]>();
  private readonly byLoose = new Map<string, NoteRef[]>();
  private readonly consensus = new Map<string, NoteRef | null>();
  private readonly fuzzy: boolean;

  constructor(notes: Iterable<NoteRef>, opts: { fuzzy?: boolean } = {}) {
    this.fuzzy = opts.fuzzy === true;
    for (const n of notes) {
      if (n.guid) this.byGuid.set(n.guid.toLowerCase(), n);
      const key = normalizeTitle(n.title);
      if (!key) continue;
      push(this.byTitle, key, n);
      const loose = looseKey(key);
      if (loose) push(this.byLoose, loose, n);
    }
  }

  /**
   * Learns from every link in the run: when the links that carry one Evernote GUID all match the same note by its
   * unique title, that GUID is that note. A link with the same GUID whose text matches nothing can then follow them.
   */
  learn(uses: Iterable<{ use: LinkUse; from: NoteRef }>): void {
    for (const { use, from } of uses) {
      const link = parseEvernoteLink(use.href);
      if (link?.kind !== "note") continue;
      // Only a title no other note has counts: a choice between namesakes is a guess, and guesses don't spread.
      const exact = this.narrow(this.byTitle.get(normalizeTitle(use.text)), from, "title");
      if (!exact || !("note" in exact) || exact.how !== "title") continue;
      for (const g of link.guids) {
        if (!this.consensus.has(g)) this.consensus.set(g, exact.note);
        else if (this.consensus.get(g) !== exact.note) this.consensus.set(g, null);
      }
    }
  }

  /** Null when the href isn't an Evernote link (leave it alone). */
  match(href: string, text: string, from: NoteRef): LinkMatch | null {
    const link = parseEvernoteLink(href);
    if (!link) return null;
    if (link.kind === "resource") return { ok: false, why: "attachment", candidates: [] };
    const guids = link.kind === "note" ? link.guids : [];
    for (const g of guids) {
      const n = this.byGuid.get(g);
      if (n) return { ok: true, note: n, how: "guid" };
    }
    const title = normalizeTitle(text);
    const exact = this.narrow(this.byTitle.get(title), from, "title");
    if (exact && "note" in exact) return { ok: true, ...exact };
    for (const g of guids) {
      const n = this.consensus.get(g);
      if (n) return { ok: true, note: n, how: "other-link" };
    }
    if (exact) return { ok: false, why: "ambiguous", candidates: exact.ambiguous };
    const key = looseKey(title);
    const loose = key ? this.narrow(this.byLoose.get(key), from, "loose") : null;
    if (loose && "note" in loose) return { ok: true, note: loose.note, how: "loose" };
    if (loose) return { ok: false, why: "ambiguous", candidates: loose.ambiguous };
    if (this.fuzzy && key.length >= 5) {
      const near = this.closest(key, from);
      if (near) return { ok: true, note: near, how: "fuzzy" };
    }
    return { ok: false, why: "missing", candidates: [] };
  }

  private narrow(list: NoteRef[] | undefined, from: NoteRef, base: LinkHow): Narrowed {
    if (!list?.length) return null;
    if (list.length === 1) return { note: list[0] as NoteRef, how: base };
    const sameBook = list.filter((n) => n.notebook === from.notebook);
    if (sameBook.length === 1) return { note: sameBook[0] as NoteRef, how: base === "title" ? "notebook" : base };
    if (sameBook.length === 0) {
      const sameStack = list.filter((n) => n.stack === from.stack);
      if (sameStack.length === 1) return { note: sameStack[0] as NoteRef, how: base === "title" ? "stack" : base };
    }
    return { ambiguous: list };
  }

  /** The one title within about 15% edits of the key, when no other title is as close. */
  private closest(key: string, from: NoteRef): NoteRef | null {
    const max = Math.max(1, Math.floor(key.length * 0.15));
    let best = Number.POSITIVE_INFINITY;
    let found: NoteRef[] = [];
    for (const [k, notes] of this.byLoose) {
      const d = distance(key, k, Math.min(max, best));
      if (d < best) {
        best = d;
        found = [...notes];
      } else if (d === best && d !== Number.POSITIVE_INFINITY) found.push(...notes);
    }
    if (!found.length) return null;
    const pick = this.narrow(found, from, "fuzzy");
    return pick && "note" in pick ? pick.note : null;
  }
}
