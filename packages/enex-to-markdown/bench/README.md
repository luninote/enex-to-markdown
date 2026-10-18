# Benchmark

enex-to-markdown, [Yarle](https://github.com/akosbalasko/yarle) and [evernote2md](https://github.com/wormi4ok/evernote2md) run on the same ENEX files; each output folder is scored the same way. Run on 2026-10-18.

## Setup

| | |
|---|---|
| Machine | Windows 11 Pro, AMD Ryzen 9 9950X3D (16 cores), 64 GB RAM, SSD |
| Runtime | Node.js 26.4.0, PowerShell 7.6.6 |
| enex-to-markdown | this repository, the bundled `dist/cli.js` |
| Yarle | 6.17.0, `npm install yarle-evernote-to-md@6.17.0 --ignore-scripts` in an empty folder, run as `node dist/dropTheRope.js --configFile <config>` |
| evernote2md | 0.23.0, the Windows release binary (SHA-256 `38eb47cb5476d2f93fc1cb5844e0041132014a1c72cb7f2e782a001f6b1030bc`, checked against the release's checksums file), run as `evernote2md <input> <output> --addFrontMatter` |

Options, chosen to give each tool its best output:

- enex-to-markdown: `--password bench-pass`, and once more with `--obsidian`.
- Yarle: the config in `run.mjs`: its sample template, metadata on, web clips kept, the password, and `StandardMD` or `ObsidianMD` for notes, tasks and image sizes. `keepEvernoteLinkIfNoNoteFound` stays at its default (`false`): with `true`, 6.17.0 left every note link pointing to Evernote in our runs, matched or not.
- evernote2md has no password option and no Obsidian mode.

Each tool gets a copy of the inputs with every `.enex` file in one folder, since Yarle reads one folder level. Every run is its own process, started by `measure.ps1`, which reports the wall time and the process's peak working set (the high-water mark Windows keeps for it).

## Inputs

| Set | What | Made by |
|---|---|---|
| corpus | 115 ENEX test files from the `test/data` folder of the [Yarle repository](https://github.com/akosbalasko/yarle/tree/master/test/data) (MIT), subfolders included, 155 notes: web clips, tables, attachments, links, damaged XML, odd names. Not included here; pass their folder with `--corpus` | Yarle's authors |
| stress | 11 files, 35 notes: links between notebooks with repeated titles, `share.evernote.com` and `/shard/…/nl/…` links, tasks with time zones, reminders and repeat rules, AES and RC2 encrypted text, names Windows reserves, a 227-character title, the same attachment name with different bytes, Windows-1252 bytes inside a UTF-8 file, a UTF-16 file, a split export | `make-inputs.mjs` |
| big | One file, three notes with a 200 MB attachment each (850 MB) | `make-inputs.mjs --big` |
| huge | One file, 1,500 notes with a 1.2 MB attachment each (2.5 GB) | `make-inputs.mjs --huge` |

`make-inputs.mjs` writes the same bytes on every run, plus `stress-expected.json`: which note each test link must land on, the dates each task must keep, the decrypted texts, the attachment hashes and the decoded texts.

## Scoring (`score.mjs`)

- **Notes, attachments:** `.md` files and other files written, without logs and reports.
- **Links:** every Markdown link, `[[wikilink]]` and HTML anchor in the output. "To a note" means it opens a `.md` file that exists (a link without `.md` counts when that file exists). "To no file" means it points to a file that doesn't exist. "To Evernote" means it still has an Evernote address.
- **Words missing:** the words of each note's title, text and task titles in the ENEX, as a reader sees them (inline tags join, block tags separate), minus the words found in the output's files and file names, counted with repeats. Encrypted data, scripts and styles are left out on both sides.
- **Stress checks:** for each test link, whether it lands on the note it should (each note carries a marker word), stays an Evernote address, or breaks. For each task, whether its line holds the expected date, the repeat, the done mark and the flag. Whether the secret texts appear, the attachment bytes match, and the re-encoded texts read correctly.

The big and huge sets are scored for notes and attachments only; their outputs are deleted after each run.

## Results

| Set | Tool | Notes | Attachments | Links: to a note / to no file / to Evernote | Words missing | Time | Peak memory |
|---|---|---|---|---|---|---|---|
| corpus | enex-to-markdown | 155 | 98 | 23 / 0 / 7 | 43 of 13,049 | 1.07 s | 141 MB |
| corpus | enex-to-markdown `--obsidian` | 155 | 98 | 23 / 0 / 7 | 43 of 13,049 | 1.06 s | 155 MB |
| corpus | Yarle StandardMD | 154 | 98 | 16 / 13 / 1 | 109 of 13,049 | 3.48 s | 309 MB |
| corpus | Yarle ObsidianMD | 154 | 98 | 22 / 7 / 1 | 109 of 13,049 | 3.39 s | 308 MB |
| corpus | evernote2md | 153 | 76 | 0 / 0 / 30 | 2,730 of 13,049 | 0.88 s | 21 MB |
| stress | enex-to-markdown | 35 | 3 | 7 / 0 / 2 | 0 of 345 | 0.28 s | 106 MB |
| stress | enex-to-markdown `--obsidian` | 35 | 3 | 7 / 0 / 2 | 0 of 345 | 0.25 s | 105 MB |
| stress | Yarle StandardMD | 35 | 3 | 4 / 4 / 1 | 2 of 345 | 0.88 s | 191 MB |
| stress | Yarle ObsidianMD | 35 | 3 | 6 / 2 / 1 | 2 of 345 | 0.90 s | 198 MB |
| stress | evernote2md | 33 | 3 | 0 / 0 / 9 | 27 of 345 | 0.15 s | 9 MB |
| big | enex-to-markdown | 3 | 3 | | | 7.27 s | 226 MB |
| big | enex-to-markdown `--obsidian` | 3 | 3 | | | 7.13 s | 232 MB |
| big | Yarle StandardMD | 3 | 3 | | | 22.5 s | 2,295 MB |
| big | Yarle ObsidianMD | 3 | 3 | | | 20.8 s | 2,295 MB |
| big | evernote2md | 3 | 3 | | | 6.90 s | 3,268 MB |
| huge | enex-to-markdown | 1,500 | 1,500 | | | 24.9 s | 254 MB |
| huge | enex-to-markdown `--obsidian` | 1,500 | 1,500 | | | 25.0 s | 253 MB |
| huge | Yarle StandardMD | 1,500 | 1,500 | | | 74.0 s | 371 MB |
| huge | Yarle ObsidianMD | 1,500 | 1,500 | | | 71.7 s | 340 MB |
| huge | evernote2md | 1,500 | 1,500 | | | 27.9 s | 28 MB |

No tool crashed or hung; every run exited with code 0.

### Stress checks

| | enex-to-markdown (both modes) | Yarle StandardMD | Yarle ObsidianMD | evernote2md |
|---|---|---|---|---|
| 9 test links | 8 to the right note; 1 left as an Evernote address and listed (it has two namesakes in other notebooks) | 4 right, 1 left, 4 broken | 4 right, 2 to the wrong namesake, 1 left, 2 broken | 9 left as Evernote addresses |
| `share.evernote.com` link | right note | left | left | left |
| Task due dates, of 5 | 5 | 0 | 3 | 0 |
| Reminder date, of 1 | 1 | 0 | 1 | 0 |
| Repeat rules, of 2 | 2 | 0 | 0 | 0 |
| Done task, of 1 | 1 | 1 | 1 | 0 (task titles missing) |
| Flag, of 1 | 1 | 0 | 1 | 0 |
| AES text | decrypted | decrypted | decrypted | locked |
| RC2 text | decrypted | locked | locked | locked |
| Attachments with the same name, different bytes | 3 of 3 | 3 of 3 | 3 of 3 | 3 of 3 |
| Windows-1252 bytes in a UTF-8 file | read correctly | replacement characters (U+FFFD) | replacement characters | note not written ("invalid UTF-8") |
| UTF-16 file | read correctly | read correctly | read correctly | file not read ("invalid UTF-8") |

"Not exported", the link to a note that isn't in the files, counts as right when it stays an Evernote address.

### What the numbers mean

- **Corpus, notes.** `test.enex` has a broken closing tag. enex-to-markdown converts its one note and lists the repair; Yarle writes nothing for that file, and its log doesn't mention it; evernote2md logs an XML error and stops reading that file. evernote2md also fails two notes with errors on the console ("open stack of elements exceeds 512 nodes", "illegal base64 data") and writes a file named `.md` for a note without a title.
- **Corpus, attachments.** Yarle and enex-to-markdown write the same 98 files, except in one web clip that holds its images both as attachments and as inline data: enex-to-markdown writes the attachments, Yarle the inline copies, under the same names. evernote2md misses the 22 images of the two notes it fails.
- **Corpus, words missing.** The 43 for enex-to-markdown, and most of Yarle's 109, are pairs such as `anonymousapril`: a clip shows two inline elements on separate lines through its CSS, the scorer joins them, the converters split them. Yarle's other missing words are the note in `test.enex`. evernote2md's 2,730 come from its two failed notes and the stopped file.
- **Corpus, links.** Of the 7 links enex-to-markdown leaves as Evernote addresses, 1 points to a note that isn't in the corpus and 6 to titles two notebooks share (the corpus holds one notebook twice, under two names). Each is listed in `conversion-warnings.txt`, with its candidates. Most of Yarle's links "to no file" point to shortened names of a long-titled note that differ from the file it wrote.
- **Where evernote2md is ahead.** It needs far less memory on ordinary files (21 MB against 141 MB on the corpus, 28 MB against 254 MB on the huge set) and is a little faster on the corpus and the stress set. Its peak on the big set, with 200 MB attachments, is 3.3 GB.

## Running it

Windows with PowerShell 7 (`pwsh`), Node.js 23.6 or newer. Put the tools outside this repository, each in its own empty folder.

```sh
node bench/make-inputs.mjs <inputs> [--big] [--huge]
node build.mjs
node bench/run.mjs --work <scratch> --inputs <inputs> --corpus <yarle>/test/data \
  --yarle <folder Yarle is installed in> --evernote2md <evernote2md.exe> --sets corpus,stress,big,huge
node bench/run.mjs --work <scratch> --inputs <inputs> --rescore
```

`run.mjs` prints the table and writes every number, with samples of missing words and broken links, to `<scratch>/results.json`. `--rescore` scores the kept outputs again without running the tools.
