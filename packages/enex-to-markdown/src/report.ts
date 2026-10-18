import type { NoteWarning } from "@luninote/enml";

/** What each finding means for the person reading the Markdown. Codes not listed here are reported by code. */
export const DESCRIPTIONS: Readonly<Record<string, string>> = {
  // the export file
  invalid_date: "A date in the export couldn't be read, so it was left out.",
  xml_error: "This part of the export file is damaged. What could be read was converted; check the note.",
  bad_base64: "An attachment's data is damaged, so its file may be incomplete.",
  empty_resource: "An attachment is empty (0 bytes) in the export.",
  resource_without_data: "An attachment has no data in the export, so no file was written for it.",
  oversized_content: "The note is very large. If it says 'cut', the end of the note is missing.",
  password_export:
    "The notebook was exported with a password, so this note's content can't be read. Export it again without a password.",
  file_skipped: "This file couldn't be read, so nothing was converted from it.",
  file_unreadable: "This file couldn't be read past this point. Notes before it were converted.",
  file_truncated: "The export file ends in the middle of a note, so that note is missing. Export the notebook again.",
  input_repaired:
    "Some bytes in this file weren't valid UTF-8. They were read as Windows-1252 (the usual cause), so check accented letters and quotes.",
  input_recoded: "This file isn't UTF-8; it was read in the encoding it declares.",
  // the conversion
  missing_resource: "The note shows an attachment that isn't in the export. A placeholder was written.",
  unsupported_element: "Content Markdown can't hold was kept as plain text.",
  remote_image: "An image is still loaded from the web; the export holds only its address.",
  encrypted:
    "Encrypted text was kept as a locked placeholder, with its encrypted data. Run again with --password to decrypt it.",
  decrypt_failed: "Encrypted text couldn't be opened with the passwords given, so it was kept as a locked placeholder.",
  decrypted: "Encrypted text was decrypted with a password you gave. It is plain text in this file now.",
  task_group_without_tasks: "A task list is empty in the export.",
  conversion_failed: "The note couldn't be converted. Its original content was kept in the file as HTML.",
  formatting_dropped: "Some formatting (background colors) was dropped.",
  alternate_data: "An attachment came with a second version of its data, saved next to it.",
  task_detail_dropped: "Part of a task didn't fit the task format and was left out:",
  path_shortened: "A name was shortened to keep the full path under the length Windows allows:",
  tags_renamed: "Tags were renamed so Obsidian accepts them (no spaces, no punctuation, not only digits):",
  // links between notes
  link_missing:
    "A link to another note still points to Evernote: no note in this run has its text as a title. Convert the notebook it's in in the same run, or see the README about links.",
  link_ambiguous:
    "A link to another note still points to Evernote: several notes in this run have its text as a title.",
  link_attachment: "A link to an attachment in Evernote still points to Evernote.",
  link_notebook: "Several notes have this link's title; the one in the same notebook was used.",
  link_stack: "Several notes have this link's title; the one in the same folder (stack) was used.",
  link_other_link:
    "No note has this link's text as its title, but another link to the same Evernote note matched one; that note was used.",
  link_loose: "A link's text matched a note's title only when ignoring case, accents, spaces and punctuation.",
  link_fuzzy: "A link was matched to the closest title (--fuzzy-links). Check that it's the right note.",
};

/** Info-level findings that still mean the Markdown differs from the note. Every warning-level finding is reported. */
const REPORTED_INFO = new Set([
  "encrypted",
  "decrypted",
  "remote_image",
  "oversized_content",
  "formatting_dropped",
  "alternate_data",
  "path_shortened",
  "input_recoded",
  "link_notebook",
  "link_stack",
  "link_other_link",
  "link_loose",
]);
// Nothing of the note is lost: Evernote's search data for images isn't written out anyway, and a date the export
// doesn't have is simply absent from the front matter (many exports from other apps carry no updated date). Link
// findings from the shared converter are replaced by this tool's own, more detailed ones.
const IGNORED = new Set(["recognition_unreadable", "missing_date", "evernote_link_unresolved"]);

export function reportable(list: readonly NoteWarning[]): NoteWarning[] {
  return list.filter(
    (w) => !IGNORED.has(w.code) && (w.severity === "warning" || REPORTED_INFO.has(w.code)) && w.count > 0,
  );
}

/** Descriptions that name a command-line option, as the browser version says them. */
export const BROWSER_WORDING: Readonly<Record<string, string>> = {
  encrypted:
    "Encrypted text was kept as a locked placeholder, with its encrypted data. Enter its password and convert again to decrypt it.",
  link_fuzzy:
    "A link was matched to the closest title (the option to match links loosely). Check that it's the right note.",
};

export function describe(w: NoteWarning, wording: Readonly<Record<string, string>> = {}): string {
  const text = wording[w.code] ?? DESCRIPTIONS[w.code] ?? w.code.replace(/_/g, " ");
  const count = w.count > 1 ? ` (${w.count} times)` : "";
  const details = w.details?.length ? `\n    ${w.details.map((d) => d.replace(/\s+/g, " ")).join("\n    ")}` : "";
  return `- ${text}${count}${details}`;
}

export interface ReportEntry {
  /** The file written (relative to the output folder), or the ENEX file for findings about the file itself. */
  where: string;
  source: string;
  warnings: NoteWarning[];
}

export function reportText(
  entries: readonly ReportEntry[],
  header: string,
  wording: Readonly<Record<string, string>> = {},
): string {
  const out = [header, ""];
  for (const e of entries) {
    out.push(`${e.where}`, `  from ${e.source}`);
    for (const w of e.warnings) out.push(`  ${describe(w, wording).replace(/\n/g, "\n  ")}`);
    out.push("");
  }
  return `${out.join("\n").trimEnd()}\n`;
}

/** Findings this tool makes itself, with every detail (the shared collector keeps only the first few). */
export class Findings {
  private readonly map = new Map<string, NoteWarning>();

  add(code: string, severity: "warning" | "info", detail?: string): void {
    let w = this.map.get(code);
    if (!w) {
      w = { code, severity, count: 0, details: [] };
      this.map.set(code, w);
    }
    w.count++;
    if (detail) w.details?.push(detail);
  }

  list(): NoteWarning[] {
    return [...this.map.values()].map(({ details, ...w }) => (details?.length ? { ...w, details } : w));
  }
}
