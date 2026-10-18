// Scores a converter's output folder: notes and attachments written, links rewritten or left, words lost against
// the ENEX files, and (for the synthetic files) the checks in stress-expected.json. Used by run.mjs.

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { Parser } from "htmlparser2";

// Reports and logs the tools write next to the notes (Yarle also copies its config file there).
const NOT_OUTPUT = /^(conversion-warnings\.txt|.*\.log|yarle_.*\.config)$/i;

export function walk(dir) {
  const out = [];
  const go = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory() && !lstatSync(p).isSymbolicLink()) go(p);
      else if (e.isFile()) out.push(p);
    }
  };
  go(dir);
  return out;
}

// ---------- the ENEX side

function decodeFile(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le");
  return buf.toString("utf8");
}

/** Text of each note in an ENEX file: title, body (without encrypted data, scripts or styles) and task titles. */
export function enexNotes(path) {
  const xml = decodeFile(readFileSync(path));
  const notes = [];
  for (const m of xml.matchAll(/<note>([\s\S]*?)<\/note>/g)) {
    const inner = m[1];
    const title = htmlText(/<title>([\s\S]*?)<\/title>/.exec(inner)?.[1] ?? "");
    const content = /<content(?:\s[^>]*)?>([\s\S]*?)<\/content>/.exec(inner)?.[1] ?? "";
    const enml = content.replace(/^\s*<!\[CDATA\[/, "").replace(/\]\]>\s*$/, "");
    const body = htmlText(enml.replace(/<(en-crypt|script|style|head)\b[\s\S]*?<\/\1\s*>/gi, " "));
    const tasks = [...inner.matchAll(/<task>[\s\S]*?<title>([\s\S]*?)<\/title>/g)].map((t) => htmlText(t[1]));
    notes.push({ title: title.trim(), text: `${title} ${body} ${tasks.join(" ")}` });
  }
  return notes;
}

const BLOCK = new Set(
  "address article aside blockquote br dd div dl dt en-media en-todo figcaption figure footer h1 h2 h3 h4 h5 h6 header hr img li main nav ol p pre section table td th tr ul".split(
    " ",
  ),
);

/**
 * Text of HTML as a reader sees it: words run on across inline tags, blocks and line breaks separate them (no tree:
 * some clips nest deeper than a recursive walk can go). The text inside a task block is left out: exports put a
 * notice there for apps without tasks, and the tasks themselves are counted from the <task> elements.
 */
function htmlText(html) {
  let out = "";
  let depth = 0;
  let skipFrom = 0;
  const p = new Parser(
    {
      ontext: (t) => {
        if (!skipFrom) out += t;
      },
      onopentag: (name, attrs) => {
        depth++;
        if (!skipFrom && /--en-task-group\s*:\s*true/i.test(attrs.style ?? "")) skipFrom = depth;
        if (BLOCK.has(name)) out += " ";
      },
      onclosetag: (name) => {
        if (skipFrom === depth) skipFrom = 0;
        depth--;
        if (BLOCK.has(name)) out += " ";
      },
    },
    { decodeEntities: true },
  );
  p.write(html);
  p.end();
  return out;
}

const words = (text) =>
  text
    .normalize("NFC")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [];

function bag(list) {
  const m = new Map();
  for (const w of list) m.set(w, (m.get(w) ?? 0) + 1);
  return m;
}

// ---------- the Markdown side

// Markdown links (also with an unencoded space or a "(1)" in them, which some tools write), [[wikilinks]] and HTML
// anchors.
const LINK =
  /(!?)\[([^\]\n]*)\]\((<[^>\n]+>|(?:[^()\n]|\([^()\n]*\))+?)(?:\s+"[^"\n]*")?\)|(!?)\[\[([^\]|\n]+)(?:\|([^\]\n]*))?\]\]|<a\s[^>]*?href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;

export function links(md) {
  const out = [];
  for (const m of md.matchAll(LINK)) {
    if (m[3] !== undefined)
      out.push({ embed: m[1] === "!", text: m[2], target: m[3].replace(/^<|>$/g, "").trim(), wiki: false });
    else if (m[5] !== undefined)
      out.push({ embed: m[4] === "!", text: m[6] ?? m[5].split("/").pop(), target: m[5], wiki: true });
    else
      out.push({ embed: false, text: m[8].replace(/<[^>]+>/g, ""), target: m[7].replace(/&amp;/g, "&"), wiki: false });
  }
  return out;
}

const isEvernote = (href) => /^evernote:|evernote\.com\//i.test(href);

/** Where a link in the file at `from` lands: an absolute path, or null when it doesn't point to a file written. */
function landing(link, from, mdFiles) {
  if (link.wiki) {
    const want = link.target.replace(/\.md$/i, "").toLowerCase();
    return mdFiles.find((f) => f.replace(/\\/g, "/").replace(/\.md$/i, "").toLowerCase().endsWith(`/${want}`)) ?? null;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(link.target)) return null;
  let rel;
  try {
    rel = decodeURIComponent(link.target.split("#")[0]);
  } catch {
    rel = link.target;
  }
  const abs = resolve(dirname(from), rel).toLowerCase();
  // A link without ".md" counts when the note file is there: some apps (Obsidian) follow it, others don't.
  return mdFiles.find((f) => f.toLowerCase() === abs || f.toLowerCase() === `${abs}.md`) ?? null;
}

/**
 * A link meant for a note: a wikilink (not one to a heading in the same note, "[[#…]]"), or a relative link to a .md
 * file or to a name without an extension.
 */
const toNote = (l) =>
  (l.wiki && !l.target.startsWith("#") && !/\.(?!md$)[A-Za-z][A-Za-z0-9]{0,7}$/i.test(l.target)) ||
  (!l.wiki && !/^[a-z][a-z0-9+.-]*:|^#/i.test(l.target) && /(\.md|\/[^./]*|^[^./]*)(#.*)?$/i.test(l.target));

export function score(outDir, enexFiles, expected) {
  const files = walk(outDir);
  // Not extname: a note with an empty title can come out as a file named just ".md".
  const md = files.filter((f) => /\.md$/i.test(f));
  const attachments = files.filter((f) => !/\.md$/i.test(f) && !NOT_OUTPUT.test(basename(f)));
  const texts = new Map(md.map((f) => [f, readFileSync(f, "utf8")]));

  let toNotes = 0;
  let broken = 0;
  let toEvernote = 0;
  const brokenSample = [];
  for (const [file, text] of texts)
    for (const l of links(text)) {
      if (l.embed) continue;
      if (isEvernote(l.target)) toEvernote++;
      else if (toNote(l)) {
        if (landing(l, file, md)) toNotes++;
        else {
          broken++;
          if (brokenSample.length < 10) brokenSample.push(`${basename(file)}: ${l.target}`);
        }
      }
    }

  const source = bag(enexFiles.flatMap((f) => enexNotes(f).flatMap((n) => words(n.text))));
  const output = bag(
    [...texts]
      .flatMap(([f, t]) => words(`${basename(f, ".md")} ${t}`))
      .concat(attachments.flatMap((f) => words(basename(f)))),
  );
  let total = 0;
  let lost = 0;
  const lostWords = new Map();
  for (const [w, n] of source) {
    total += n;
    const miss = Math.max(0, n - (output.get(w) ?? 0));
    if (miss) {
      lost += miss;
      lostWords.set(w, miss);
    }
  }
  const result = {
    notes: md.length,
    attachments: attachments.length,
    linksToNotes: toNotes,
    linksBroken: broken,
    brokenSample,
    linksToEvernote: toEvernote,
    words: total,
    wordsLost: lost,
    lostSample: [...lostWords]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([w, n]) => `${w}×${n}`),
  };
  if (expected) result.checks = checks(md, texts, attachments, expected);
  return result;
}

function checks(md, texts, attachments, expected) {
  const tokenFile = (id) => md.find((f) => texts.get(f).includes(`token-${id}`)) ?? null;
  const links = { correct: 0, wrong: 0, leftToEvernote: 0, broken: 0, dropped: 0, details: [] };
  for (const want of expected.links) {
    const from = tokenFile(want.from);
    const found = from ? linksIn(texts.get(from)).find((l) => norm(l.text) === norm(want.text)) : null;
    let verdict;
    if (!found) verdict = "dropped";
    else if (isEvernote(found.target)) verdict = want.target === null ? "correct" : "leftToEvernote";
    else {
      const to = landing(found, from, md);
      if (!to) verdict = "broken";
      else verdict = want.target && texts.get(to).includes(`token-${want.target}`) ? "correct" : "wrong";
    }
    links[verdict]++;
    links.details.push(`${want.from} "${want.text}": ${verdict}`);
  }

  const all = [...texts.values()].join("\n");
  const lineOf = (title) => all.split("\n").find((l) => l.includes(title)) ?? "";
  const tasks = {
    due: 0,
    dueOf: 0,
    reminders: 0,
    remindersOf: 0,
    repeats: 0,
    repeatsOf: 0,
    done: 0,
    doneOf: 0,
    flags: 0,
    flagsOf: 0,
  };
  for (const t of expected.tasks) {
    const line = lineOf(t.title);
    if (t.due) {
      tasks.dueOf++;
      if (line.includes(t.due)) tasks.due++;
    }
    if (t.reminder) {
      tasks.remindersOf++;
      if (line.includes(t.reminder)) tasks.reminders++;
    }
    if (t.repeats) {
      tasks.repeatsOf++;
      if (/every|repeat|FREQ=|🔁/i.test(line)) tasks.repeats++;
    }
    if (t.done) {
      tasks.doneOf++;
      if (/\[x\]/i.test(line)) tasks.done++;
    }
    if (t.flagged) {
      tasks.flagsOf++;
      if (/flag|⏫|🔺|🔼/i.test(line.replace(t.title, ""))) tasks.flags++;
    }
  }
  const secrets = expected.secrets.map((s) => `${s.cipher}: ${all.includes(s.text) ? "decrypted" : "kept locked"}`);
  const hashes = new Set(attachments.map((f) => createHash("md5").update(readFileSync(f)).digest("hex")));
  const kept = expected.attachments.filter((h) => hashes.has(h)).length;
  const textChecks = expected.texts.map((t) => `${t.note}: ${all.normalize("NFC").includes(t.text) ? "ok" : "wrong"}`);
  return {
    notesExpected: expected.notes,
    links,
    tasks,
    secrets,
    attachmentsKept: `${kept}/${expected.attachments.length}`,
    texts: textChecks,
  };
}

const norm = (s) =>
  s
    .replace(/\\(.)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
const linksIn = (text) => links(text).filter((l) => !l.embed);
