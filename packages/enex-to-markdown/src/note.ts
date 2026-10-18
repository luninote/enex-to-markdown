import { parseEnexDate } from "@luninote/enml";
import { type DocNode, fragmentText } from "@luninote/export";

export type FrontMatterMode = "none" | "minimal" | "standard" | "full";
export const FRONT_MATTER_MODES: readonly FrontMatterMode[] = ["none", "minimal", "standard", "full"];

export interface NoteMeta {
  title: string;
  created: Date | null;
  updated: Date | null;
  tags: readonly string[];
  /** The note's other attributes from the export (source-url, author, reminder-time, latitude…), as text. */
  attributes: Readonly<Record<string, string>>;
  /** Other names the note is known by (Obsidian `aliases`): its title, when the file name had to differ. */
  aliases?: readonly string[];
}

// JSON strings are valid YAML double-quoted scalars, so every value is written that way: no title, tag or URL can
// break the front matter.
const q = (s: string) => JSON.stringify(s);

const iso = (d: Date) => d.toISOString().replace(/\.000Z$/, "Z");

/** A date in ISO form; one in a form the export format doesn't use is kept as written, never dropped. */
const date = (raw: string | undefined) => {
  const text = raw?.trim();
  if (!text) return null;
  const d = parseEnexDate(text);
  return d ? iso(d) : q(text);
};

// Attributes written under their own key by `standard`, or folded into another key, so `full` doesn't repeat them.
const USED = new Set([
  "source-url",
  "author",
  "reminder-time",
  "reminder-done-time",
  "reminder-order",
  "latitude",
  "longitude",
]);

/**
 * YAML front matter. `minimal`: title, dates, tags. `standard` adds the source address, the author and the note's
 * reminder. `full` adds everything else the export holds about the note (location, the app it was made in, …).
 */
export function frontMatter(m: NoteMeta, mode: FrontMatterMode = "standard"): string {
  if (mode === "none") return "";
  const a = m.attributes;
  const lines = ["---", `title: ${q(m.title)}`];
  if (m.aliases?.length) {
    lines.push("aliases:");
    for (const alias of m.aliases) lines.push(`  - ${q(alias)}`);
  }
  if (m.created) lines.push(`created: ${iso(m.created)}`);
  if (m.updated) lines.push(`updated: ${iso(m.updated)}`);
  if (m.tags.length) {
    lines.push("tags:");
    for (const t of m.tags) lines.push(`  - ${q(t)}`);
  }
  if (mode !== "minimal") {
    if (a["source-url"]?.trim()) lines.push(`source: ${q(a["source-url"].trim())}`);
    if (a.author?.trim()) lines.push(`author: ${q(a.author.trim())}`);
    const reminder = date(a["reminder-time"]);
    const done = date(a["reminder-done-time"]);
    if (reminder) lines.push(`reminder: ${reminder}`);
    if (done) lines.push(`reminder-done: ${done}`);
  }
  if (mode === "full") {
    const lat = Number(a.latitude);
    const long = Number(a.longitude);
    if (a.latitude?.trim() && a.longitude?.trim() && Number.isFinite(lat) && Number.isFinite(long))
      lines.push(`location: [${lat}, ${long}]`);
    if (a["reminder-order"]?.trim()) lines.push(`reminder-order: ${q(a["reminder-order"].trim())}`);
    for (const [k, v] of Object.entries(a).sort(([x], [y]) => x.localeCompare(y))) {
      if (USED.has(k) || !v.trim() || !/^[a-z][a-z0-9-]*$/i.test(k)) continue;
      const key = k === "source" ? "source-app" : k;
      lines.push(`${key}: ${/date|time/i.test(k) ? date(v) : q(v.trim())}`);
    }
  }
  lines.push("---", "");
  return `${lines.join("\n")}\n`;
}

export function titleHeading(title: string): string {
  return `# ${title.replace(/\s+/g, " ").replace(/[\\`*_[\]<>]/g, "\\$&")}`;
}

/** A fenced block that no backtick run inside the text can close early. */
export function fenced(text: string, lang = ""): string {
  const runs = text.match(/`+/g) ?? [];
  const fence = "`".repeat(Math.max(3, ...runs.map((r) => r.length + 1)));
  return `${fence}${lang}\n${text}\n${fence}`;
}

/**
 * A tag as Obsidian accepts it: no spaces (they become "-"), only letters, numbers, "_", "-", "/" and emoji, and not
 * only digits.
 */
export function obsidianTag(tag: string): string {
  let s = tag
    .trim()
    .replace(/^#+/, "")
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}\p{M}\p{Extended_Pictographic}_\-/]/gu, "_")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+|\/+$/g, "");
  if (!s) s = "_";
  if (/^[\d/]+$/.test(s)) s = `_${s}`;
  return s;
}

/**
 * Content the converter couldn't map shows as its own text. When it has none (a missing attachment, an empty element),
 * a visible marker is written instead, so the reader sees that something was there.
 */
export function markUnconverted(node: DocNode): DocNode {
  if (node.type === "unsupported") {
    const raw = String(node.attrs?.raw ?? "");
    if (fragmentText(raw)) return node;
    const tag = /^<\s*([a-z][\w:-]*)/i.exec(raw)?.[1]?.toLowerCase();
    const text = tag === "en-media" ? "[Missing attachment]" : `[Not converted: ${tag ?? "content"}]`;
    return node.marks ? { type: "text", text, marks: node.marks } : { type: "text", text };
  }
  if (!node.content) return node;
  return { ...node, content: node.content.map(markUnconverted) };
}
