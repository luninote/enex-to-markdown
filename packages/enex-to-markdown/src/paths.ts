import { safeName } from "@luninote/export";
import { sha1Hex } from "./hash.ts";

/**
 * Windows programs that don't opt in to long paths can't open a file whose full path is 260 characters or more. Names
 * are shortened so every path stays under this, with a margin for a " (2)" a duplicate name may get.
 */
export const MAX_PATH = 250;

/** Characters that break an Obsidian [[link]] or embed when they're in a file or folder name. */
export const obsidianName = (name: string) => name.replace(/[#^[\]|]/g, "_");

/**
 * `name` cut to `max` characters, deterministically: the start of the name, "~", and six characters of a hash of the
 * whole name, so two long names that start alike stay apart and a rerun gives the same name.
 */
export function shortenTo(name: string, max: number): string {
  const safe = safeName(name);
  if (safe.length <= max) return safe;
  const tag = `~${sha1Hex(name).slice(0, 6)}`;
  const keep = Math.max(1, max - tag.length);
  let cut = "";
  for (const ch of safe) {
    if (cut.length + ch.length > keep) break;
    cut += ch;
  }
  return `${cut.replace(/[. ]+$/, "")}${tag}`;
}

const PART = /^(.*?) \((\d{1,3})\)$/;

/**
 * A notebook exported in several goes arrives as "Work.enex", "Work (1).enex", "Work (2).enex" (browsers and file
 * managers number repeated names this way). Files in one folder whose names differ only by such a number are parts of
 * one notebook, as long as there are at least two of them. A single "Work (1).enex" is left alone: the notebook may be
 * called that.
 */
export function splitParts<T extends { name: string; relDir: string }>(sources: readonly T[]): Map<T, string> {
  const groups = new Map<string, T[]>();
  const nameOf = (s: T) => s.name.replace(/\.enex$/i, "");
  for (const s of sources) {
    const name = nameOf(s);
    const base = PART.exec(name)?.[1] ?? name;
    const key = `${s.relDir}\u0000${base.toLowerCase()}`;
    const list = groups.get(key);
    if (list) list.push(s);
    else groups.set(key, [s]);
  }
  const out = new Map<T, string>();
  for (const list of groups.values()) {
    if (list.length < 2 || !list.some((s) => PART.test(nameOf(s)))) continue;
    const plain = list.find((s) => !PART.test(nameOf(s)));
    const base = plain ? nameOf(plain) : (PART.exec(nameOf(list[0] as T))?.[1] as string);
    for (const s of list) out.set(s, base);
  }
  return out;
}
