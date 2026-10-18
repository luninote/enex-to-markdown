import { ARCHIVE_VERSION, type ExportFormat } from "./archive.ts";

export function readmeText(opts: {
  exportedAt: string;
  formats: ExportFormat[];
  includeTrash: boolean;
  includeHistory: boolean;
  notes: number;
  attachments: number;
  missingAttachments: number;
}): string {
  const has = (f: ExportFormat) => opts.formats.includes(f);
  const lines = [
    "LuniNote export",
    "================",
    "",
    `Made ${opts.exportedAt}. ${opts.notes} notes, ${opts.attachments} attachment files.`,
    opts.includeTrash ? "Notes in the Trash are included (under trash/)." : "Notes in the Trash are not included.",
    "",
    "What's in this archive",
    "----------------------",
  ];
  if (has("enex"))
    lines.push(
      "",
      "enex/<Stack>/<Notebook>.enex",
      "  One file per notebook, in the ENEX format Evernote and many other note apps import.",
      "  Notebooks in a stack are in a folder named after the stack. Attachments are inside the files.",
      "  Notes imported from Evernote and not changed since keep their original content exactly.",
      "  Nested tags are written by their own name: ENEX has no tag hierarchy.",
    );
  if (has("html"))
    lines.push(
      "",
      "html/<Notebook>/<Note>.html",
      "  Each note as a web page you can open in any browser, offline. Links to other notes and",
      "  attachments point at their files in this archive. Saved web pages appear in a frame.",
    );
  if (has("markdown"))
    lines.push(
      "",
      "markdown/<Notebook>/<Note>.md",
      "  Each note as Markdown (GitHub style). Formatting Markdown has no syntax for (underline,",
      "  colors, highlights, merged table cells, saved web pages) is written as HTML inside the file.",
    );
  if (has("json"))
    lines.push(
      "",
      "luninote-export.json and notes/<id>.json",
      `  Everything LuniNote stores, lossless (format "luninote-export", version ${ARCHIVE_VERSION}):`,
      "  notebooks, stacks, nested tags, saved searches, shortcuts in luninote-export.json; each note's",
      "  content, dates, tags, notebook, source, author, reminders, Trash state, conflict-copy link and",
      `  attachments (with their recognized text) in notes/<id>.json${opts.includeHistory ? ", with its earlier versions" : ""}.`,
      "  notes/<id>.enml is a note's original Evernote content, for notes imported from Evernote.",
    );
  if (has("html") || has("markdown") || has("json"))
    lines.push(
      "",
      "attachments/<sha256>.<ext>",
      "  Every attachment once, named by the SHA-256 of its bytes. The HTML, Markdown and JSON files",
      "  refer to these.",
    );
  if (opts.missingAttachments)
    lines.push(
      "",
      `${opts.missingAttachments} attachment file(s) couldn't be read from storage; luninote-export.json lists them.`,
    );
  lines.push(
    "",
    "File names",
    "----------",
    "Characters some systems don't allow in file names are replaced by _, long names are shortened, and",
    'notes with the same title get "(2)", "(3)" after the name. The exact titles are inside the files.',
    "",
  );
  return lines.join("\r\n");
}
