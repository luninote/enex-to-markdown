// Links between notes. Evernote writes them as `evernote:///view/<user>/<shard>/<noteGuid>/<noteGuid>/` (app
// links), `https://www.evernote.com/shard/<shard>/nl/<user>/<noteGuid>/` (web links) or
// `https://share.evernote.com/note/<noteGuid>` (links copied in the web app). A plain ENEX carries no
// note GUIDs, so those resolve by title; exports made with `evernote-backup --add-guid` do carry them.

/** Our own in-app note link. The web app routes it; the original Evernote href stays in the kept ENML. */
export const NOTE_LINK_PREFIX = "/note/";

export function noteHref(noteId: string): string {
  return `${NOTE_LINK_PREFIX}${noteId}`;
}

export type EvernoteLink =
  | { kind: "note"; guids: string[] }
  | { kind: "resource"; guids: string[] }
  | { kind: "opaque" };

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GUID_IN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Classifies an href as an Evernote-internal link, or null when it points anywhere else. */
export function parseEvernoteLink(href: string): EvernoteLink | null {
  const h = href.trim();
  if (/^evernote:/i.test(h)) {
    const path = h.replace(/^evernote:\/*/i, "").split(/[?#]/)[0] ?? "";
    const parts = path.split("/").filter(Boolean);
    if (parts[0]?.toLowerCase() === "view") {
      const guids = parts.slice(3).filter((p) => GUID.test(p));
      return guids.length ? { kind: "note", guids: unique(guids) } : { kind: "opaque" };
    }
    return { kind: "opaque" };
  }
  let url: URL;
  try {
    url = new URL(h);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol) || !/(^|\.)evernote\.com$/i.test(url.hostname)) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  const shard = parts[0]?.toLowerCase() === "shard" ? parts.slice(2) : parts;
  const kind = shard[0]?.toLowerCase();
  if (kind === "nl") {
    const guids = shard.slice(2).filter((p) => GUID.test(p));
    return guids.length ? { kind: "note", guids: unique(guids) } : { kind: "opaque" };
  }
  // `sh/<noteGuid>/<shareKey>` (public link) and `share.evernote.com/note/<noteGuid>` (shared note).
  if (kind === "sh" || kind === "note") {
    const guid = shard[1];
    if (guid && GUID.test(guid)) return { kind: "note", guids: [guid.toLowerCase()] };
    if (kind === "sh") return { kind: "opaque" };
  }
  if (kind === "res") return { kind: "resource", guids: (shard[1] ?? "").match(GUID_IN) ?? [] };
  // Web-app URLs carry the note GUID in an `n=` parameter, in the query or the fragment.
  const n = /[?&#]n=([0-9a-f-]{36})/i.exec(`${url.search}${url.hash}`)?.[1];
  if (n && GUID.test(n)) return { kind: "note", guids: [n.toLowerCase()] };
  if (kind === "l" || kind === "note" || kind === "client") return { kind: "opaque" };
  return null;
}

function unique(guids: string[]): string[] {
  return [...new Set(guids.map((g) => g.toLowerCase()))];
}

export interface LinkTarget {
  noteId: string;
  title: string;
  guid: string | null;
  /** False for notes outside the current import batch: GUIDs are unique everywhere, titles are not. */
  matchTitle?: boolean;
}

export type LinkResolution =
  | { kind: "resolved"; href: string; noteId: string; by: "guid" | "title" }
  | { kind: "unresolved"; reason: string };

export function normalizeTitle(title: string): string {
  return title.normalize("NFC").replace(/\s+/g, " ").trim();
}

export class NoteLinkResolver {
  private readonly byGuid = new Map<string, string>();
  private readonly byTitle = new Map<string, string[]>();

  constructor(targets: Iterable<LinkTarget>) {
    for (const t of targets) {
      if (t.guid) this.byGuid.set(t.guid.toLowerCase(), t.noteId);
      if (t.matchTitle === false) continue;
      const key = normalizeTitle(t.title);
      if (!key) continue;
      const list = this.byTitle.get(key);
      if (list) list.push(t.noteId);
      else this.byTitle.set(key, [t.noteId]);
    }
  }

  get hasGuids(): boolean {
    return this.byGuid.size > 0;
  }

  /** Null when the href is not an Evernote link (leave it alone). */
  resolve(href: string, linkText: string): LinkResolution | null {
    const link = parseEvernoteLink(href);
    if (!link) return null;
    if (link.kind === "resource") return { kind: "unresolved", reason: "link to an Evernote attachment" };
    if (link.kind === "note") {
      for (const g of link.guids) {
        const id = this.byGuid.get(g);
        if (id) return { kind: "resolved", href: noteHref(id), noteId: id, by: "guid" };
      }
    }
    const title = normalizeTitle(linkText);
    const candidates = title ? this.byTitle.get(title) : undefined;
    if (candidates?.length === 1) {
      const id = candidates[0] as string;
      return { kind: "resolved", href: noteHref(id), noteId: id, by: "title" };
    }
    if (candidates && candidates.length > 1)
      return { kind: "unresolved", reason: `${candidates.length} imported notes have this title` };
    if (link.kind === "opaque") return { kind: "unresolved", reason: "Evernote link without a note id" };
    return { kind: "unresolved", reason: "target note not in this import" };
  }
}
