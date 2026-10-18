<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/luninote/enex-to-markdown/main/packages/enex-to-markdown/assets/banner-dark.svg?sanitize=true">
  <img alt="enex-to-markdown: Evernote exports to clean Markdown. Nothing lost silently." src="https://raw.githubusercontent.com/luninote/enex-to-markdown/main/packages/enex-to-markdown/assets/banner-light.svg?sanitize=true" width="100%">
</picture>

<p align="center">
  <a href="https://www.npmjs.com/package/@luninote/enex-to-markdown"><img alt="npm" src="https://img.shields.io/npm/v/@luninote/enex-to-markdown?style=flat-square&color=f1a312"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-2a2a29?style=flat-square"></a>
  <a href="https://nodejs.org"><img alt="Node.js 20 or newer" src="https://img.shields.io/badge/node-%3E%3D20-2a2a29?style=flat-square"></a>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#--obsidian">Obsidian</a> ·
  <a href="#what-converts">What converts</a> ·
  <a href="#compared-with-other-converters">Compared</a>
</p>

Moving your notes out of Evernote shouldn't cost you any of them. enex-to-markdown turns Evernote's ENEX exports into a folder of plain Markdown files, with attachments, tags, tasks and the links between your notes. When something can't be converted cleanly, it says so in a file you can read, note by note, so you know exactly what to check before you delete anything.

<img alt="enex-to-markdown converting Travel.enex in a terminal" src="https://raw.githubusercontent.com/luninote/enex-to-markdown/main/packages/enex-to-markdown/assets/terminal.svg?sanitize=true" width="100%">

## Quick start

```sh
npx @luninote/enex-to-markdown "My Notebook.enex"
```

You need Node.js 20 or newer. To keep it installed: `npm install -g @luninote/enex-to-markdown`, then run `enex-to-markdown`.

To get ENEX files, open the Evernote desktop app, right-click a notebook and export it as ENEX. Export all of them and convert them in one run, so links between notebooks can be matched.

### No install: use it in your browser

The same converter runs as a web page at [luninote.com/tools/enex-to-markdown](https://luninote.com/tools/enex-to-markdown). Drop your `.enex` files or a folder, pick the options, and download a ZIP with the same Markdown, attachments and `conversion-warnings.txt`. Your notes stay in the browser tab: the page's security policy blocks it from sending anything anywhere.

Chrome and Edge write the ZIP straight to a file you choose, so the size of your archive doesn't matter (tested with a 2.5 GB export). Other browsers build the whole ZIP in memory first, so for archives over about 1 GB use Chrome, Edge or the command. The web version has no dry run.

## Why this one

Every problem lands in `conversion-warnings.txt`: a damaged part of a file, a missing attachment, a link it couldn't match, a task detail the output format can't hold. The other converters we tested write no such file, so a dropped note or a broken link can go unnoticed.

Links between notes keep working, across notebooks too. They become relative links to the other `.md` file, or `[[wikilinks]]` with `--obsidian`. When two notes share a title, it picks the one in the same notebook or stack, and a link it can't settle is left as it was and listed with the notes it could point to, instead of being guessed.

Evernote Tasks keep their due dates, reminders, flags and repeat rules. With `--obsidian` they come out in the format of the Obsidian Tasks plugin.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/luninote/enex-to-markdown/main/packages/enex-to-markdown/assets/before-after-dark.svg?sanitize=true">
  <img alt="A note with tags, a dated task, a link and an attachment, and the Markdown file it becomes" src="https://raw.githubusercontent.com/luninote/enex-to-markdown/main/packages/enex-to-markdown/assets/before-after.svg?sanitize=true" width="100%">
</picture>

## Usage

```sh
enex-to-markdown <file.enex | folder> [more files or folders] [options]
```

Give it one or more `.enex` files, or a folder. A folder is searched for `.enex` files, subfolders included. Convert all your notebooks in one run: links can only be matched to notes that are in the run.

| Option | What it does |
|---|---|
| `-o, --out <folder>` | Where to write. Default: `./markdown-export` |
| `--obsidian` | Write for Obsidian (see below) |
| `--dry-run` | Read everything and write only `conversion-warnings.txt`, to see what wouldn't convert |
| `--password <text>` | Decrypt encrypted text with this password. Give it more than once to try several |
| `--password-file <file>` | Passwords to try, one per line |
| `--frontmatter <mode>` | `none`, `minimal`, `standard` (default) or `full` |
| `--date-prefix` | Start each file name with the note's creation date, `2025-03-01 Trip plan.md` |
| `--fuzzy-links` | Also match a link to the closest note title. Every link matched this way is listed |
| `--no-merge-parts` | Keep `Work (1).enex`, `Work (2).enex` in separate folders |
| `--overwrite` | Write into an output folder that already has files in it |
| `--keep-clip-html` | Keep heavily styled web clips as HTML instead of converting them |
| `--keep-colors` | Keep text colors and fonts, as inline HTML |
| `-q, --quiet` | Print only the summary |
| `-h, --help`, `-v, --version` | Help, version |

## What you get

From a folder `exports` that holds `Work/Projects.enex`, `Work/Money.enex`, `Diary.enex`, `Diary (1).enex` and `Diary (2).enex`, `enex-to-markdown exports` writes:

```
markdown-export/
  Work/                      <- a subfolder (a stack)
    Projects/                <- Work/Projects.enex
      Kickoff.md
      Plan.md
      _resources/
        Kickoff/
          diagram.png
    Money/                   <- Work/Money.enex
      Budget.md
  Diary/                     <- Diary.enex, Diary (1).enex and Diary (2).enex together
    Monday.md
  conversion-warnings.txt
```

- Each `.enex` file becomes a folder named after it. Subfolders of a folder you pass in are kept, so put each stack's notebooks in a folder named after the stack and the stack stays together. Links prefer a note in the same stack.
- A notebook exported in several parts (`Work.enex`, `Work (1).enex`, `Work (2).enex`, as browsers name repeated downloads) goes into one folder. This needs at least two such files side by side; a lone `Work (1).enex` keeps its name. `--no-merge-parts` turns it off.
- Each note becomes one `.md` file named after its title. Repeated titles get `Title (2).md`. Characters files can't use become `_`, and names Windows reserves (`CON`, `NUL`, …) are changed.
- A name that would make the full path longer than Windows allows (260 characters) is shortened: the start of the name, `~` and six characters from a hash of the whole name. The same input gives the same names on every run, and each shortened name is listed in the warnings file.
- Attachments go in `_resources/<note name>/`, byte for byte, linked from the note with relative links.
- Each file's modified time is set to the note's updated date.

### Front matter

`standard` (the default):

```yaml
---
title: "Trip plan"
created: 2025-03-01T09:00:00Z
updated: 2025-03-02T10:15:00Z
tags:
  - "travel"
source: "https://example.com/itinerary"
author: "A. Traveller"
reminder: 2025-03-05T08:00:00Z
---
```

`minimal` keeps title, dates and tags. `full` adds everything else the export holds about the note: location, the app it was made in, the reminder order and so on. `none` writes no front matter, only a `# Title` heading.

## How links are matched

An ENEX file has no ids for notes, so a link is matched to the note whose title is the link's text. When several notes share that title, it prefers, in this order:

1. a note whose Evernote id matches the link (only when the export carries ids, see below),
2. the one note with that exact title,
3. the note with that title in the same `.enex` file,
4. then in the same folder you passed in (the stack),
5. the note that another link with the same Evernote address was matched to,
6. the one note whose title matches when case, accents, spaces and punctuation are ignored.

Every match made by rules 3 to 6 is listed in the warnings file. A link that still has several candidates, or none, keeps its Evernote address and is listed with its candidates. `--fuzzy-links` adds one more rule: the closest title, when exactly one is close enough. It never runs by default, and every link it matches is listed.

Links in all three forms are read: `evernote:///view/…`, `https://www.evernote.com/shard/…/nl/…` and `https://share.evernote.com/note/…`.

For exact links, export with ids. [evernote-backup](https://github.com/vzhd1701/evernote-backup) can write ENEX files that carry each note's id: after its `init-db` and `sync`, run `evernote-backup export --add-guid <folder>`. Links to those notes then match by id, whatever the titles are.

## `--obsidian`

- Links to notes are `[[Note]]`, or `[[Folder/Note]]` when the name is used more than once. The link text becomes an alias, `[[Note|text]]`, when it differs.
- Images, audio, video and PDFs are embedded with `![[file]]` (with the note's width, `![[file|300]]`). Other attachments are linked with `[[file]]`.
- Tasks use the format of the Obsidian Tasks plugin: priority from the flag `⏫`, repeat `🔁 every week on Monday`, scheduled date from the reminder `⏳`, due date `📅`, done date `✅`. Times of day and extra reminders don't fit that format; each one is listed in the warnings file.
- Highlights are `==text==`.
- Tags are written so Obsidian accepts them: spaces become `-`, other characters it doesn't allow become `_`, and a tag of only digits gets a leading `_`. Each changed tag is listed.
- The title is in the front matter, and also as an alias when the file name had to differ from it. There is no `# Title` heading, since Obsidian shows the file name.
- `#`, `^`, `[`, `]` and `|` in file and folder names become `_`, since they break links.

Without `--obsidian`, the output is portable CommonMark with GitHub tables and task lists, and relative links that work in any Markdown app.

## What converts

| In the note | In the Markdown |
|---|---|
| Headings, bold, italic, strikethrough, lists, quotes, horizontal rules | Markdown |
| Code blocks | Fenced code blocks, with the language when the note has one |
| Underline, highlight, superscript, subscript | Inline HTML (`<u>`, `<mark>`, `<sup>`, `<sub>`); highlight is `==text==` with `--obsidian` |
| Text color and font | Left out, so notes read cleanly. `--keep-colors` keeps them as `<span style>` |
| Checkboxes | `- [ ]` and `- [x]` |
| Tasks | `- [ ]` with due date, reminders, repeat, flag and done date after it; Obsidian Tasks format with `--obsidian` |
| Tables | GitHub tables. Line breaks, images, lists and code in a cell stay in the table (lists and code as inline HTML). Tables with merged cells or a table inside a cell become HTML tables |
| Images and attachments | Files in `_resources`, linked with `![…](…)` or `[…](…)` |
| Images embedded in the note as data | Saved as files too |
| Encrypted text | Decrypted with `--password` (both kinds Evernote has used). Otherwise, or with a wrong password, a locked placeholder with the encrypted data and hint kept, listed in the warnings file. Passwords are never printed |
| Web clips | Converted to Markdown. With `--keep-clip-html`, heavily styled clips stay as HTML (scripts removed) |

Files are read as a stream and attachments are written straight to disk, so a 2.5 GB ENEX file converts in about 250 MB of memory (see [bench/](bench/)).

Files that aren't clean UTF-8 are read too: UTF-16 files, files that declare another encoding, and UTF-8 files with stray bytes from another encoding (read as Windows-1252, and listed). Damaged XML is repaired where it can be; what could be read is converted and the note is listed.

## Compared with other converters

Measured on 2026-10-18 on one Windows 11 machine. The method, the inputs and every number are in [bench/](bench/). Obsidian Importer runs inside the Obsidian app, so it wasn't measured; its column cites its public issue tracker only.

| | enex-to-markdown | [Yarle](https://github.com/akosbalasko/yarle) 6.17.0 | [evernote2md](https://github.com/wormi4ok/evernote2md) 0.23.0 | [Obsidian Importer](https://github.com/obsidianmd/obsidian-importer) |
|---|---|---|---|---|
| A file listing what didn't convert | `conversion-warnings.txt` | None written | None written; errors on the console | Requested in [#294](https://github.com/obsidianmd/obsidian-importer/issues/294) (open); silent data loss reported in [#547](https://github.com/obsidianmd/obsidian-importer/issues/547) |
| 115 sample files, 155 notes: notes written | 155 | 154: a file with a broken tag skipped | 152: 2 notes failed, the file with a broken tag stopped | not measured |
| 9 test links between notebooks, with repeated titles | 8 right, 1 left and listed | 4 right, 2 to the wrong note, 1 left, 2 broken (Obsidian mode) | 9 left | not measured |
| `share.evernote.com` note links | Matched | Left; open: [#655](https://github.com/akosbalasko/yarle/issues/655) | Left | not measured |
| Task due dates kept, of 5 | 5 | 3 in Obsidian mode, 0 in Markdown mode | 0 | not measured |
| Repeating tasks kept, of 2 | 2 | 0; open: [#665](https://github.com/akosbalasko/yarle/issues/665) | 0 | not measured |
| Encrypted text decrypted, AES / RC2 | Both | AES only | Neither | not measured |
| Windows-1252 bytes in a UTF-8 file | Read correctly | Replacement characters | Note not written; open: [#143](https://github.com/wormi4ok/evernote2md/issues/143) | not measured |
| Peak memory, three 200 MB attachments | 226 MB | 2,295 MB | 3,268 MB | not measured |

All three tools finished every run without crashing or hanging.

## Known limits

- Links are matched by title unless the export carries note ids (see above). Links to notes that aren't in the run keep their Evernote address and are listed.
- Password-protected exports can't be read. Each note gets a placeholder file; export again without a password.
- Shortcuts, saved searches, note history and notebook stacks (other than the folders you pass in) aren't in ENEX files, so they can't be converted.
- Text that Evernote recognized in images is search data in the export and isn't written out.
- Background colors on paragraphs and table cells are dropped and listed.
- Text that was already garbled before the export (such as `Ã©` for `é`) is kept as it is, since guessing could change text that is correct.
- Some Markdown apps render inline HTML (underline, tables with merged cells) and some don't.

## Rather skip the conversion?

[LuniNote](https://luninote.com) is a notes app for people leaving Evernote. It imports ENEX files as they are, with notebooks, tags, tasks, attachments and the links between notes, and shows a report of what came over. The same people make this converter.

## License

MIT. See [LICENSE](LICENSE). The bundled command includes open-source packages; their licenses are in `dist/THIRD-PARTY-LICENSES.txt`.

Evernote is a trademark of its owner. This project isn't affiliated with or endorsed by Evernote.
