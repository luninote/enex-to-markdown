// Writes the synthetic ENEX files the benchmark runs on, and stress-expected.json with what a converter should produce from
// them. Deterministic: the same files every run. Needs Node 23.6 or newer (it imports the TypeScript sources).
//
//   node bench/make-inputs.mjs <folder> [--big] [--huge]
//
//   <folder>/stress/   small files: links and duplicate titles across notebooks, tasks, encrypted text, awkward
//                      names, rich content, encodings, a split export
//   <folder>/big/      --big: three notes with a 200 MB attachment each (about 850 MB of ENEX)
//   <folder>/huge/     --huge: 1,500 notes with a 1.2 MB attachment each (about 2.5 GB of ENEX)

import { createCipheriv, createHash, createHmac, pbkdf2Sync } from "node:crypto";
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { rc2Checks } from "../src/crypt.ts";
import { rc2EncryptEcb, rc2Keys } from "../src/rc2.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { big: { type: "boolean" }, huge: { type: "boolean" } },
});
const root = positionals[0];
if (!root) {
  console.error("usage: node bench/make-inputs.mjs <folder> [--big] [--huge]");
  process.exit(2);
}

export const PASSWORD = "bench-pass";

// Deterministic bytes: AES-CTR over zeros with a fixed key.
function bytes(seed, length) {
  const key = createHash("sha256").update(String(seed)).digest().subarray(0, 16);
  const c = createCipheriv("aes-128-ctr", key, Buffer.alloc(16));
  return c.update(Buffer.alloc(length));
}
const md5 = (b) => createHash("md5").update(b).digest("hex");
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const guid = (n) => `5e0d1c2b-0000-4000-8000-${String(n).padStart(12, "0")}`;
const appLink = (text, n) => `<a href="evernote:///view/123/s1/${guid(n)}/${guid(n)}/">${text}</a>`;

const HEAD =
  '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE en-export SYSTEM "http://xml.evernote.com/pub/evernote-export4.dtd">\n<en-export export-date="20260101T000000Z" application="Evernote" version="10.100">\n';
const FOOT = "</en-export>\n";

function resourceXml(r) {
  const attrs = r.fileName
    ? `<resource-attributes><file-name>${esc(r.fileName)}</file-name></resource-attributes>`
    : "";
  return `<resource><data encoding="base64">${r.data.toString("base64")}</data><mime>${r.mime}</mime>${attrs}</resource>`;
}

function noteXml(n) {
  const tags = (n.tags ?? []).map((t) => `<tag>${esc(t)}</tag>`).join("");
  const content = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd"><en-note>${n.body ?? ""}</en-note>`;
  return `<note><title>${esc(n.title)}</title><created>${n.created ?? "20240102T030405Z"}</created><updated>20240103T030405Z</updated>${tags}<content><![CDATA[${content}]]></content>${(n.resources ?? []).map(resourceXml).join("")}${n.extra ?? ""}</note>\n`;
}

const enex = (notes) => HEAD + notes.map(noteXml).join("") + FOOT;

function put(rel, text) {
  const path = join(root, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

// ---------- stress: links and duplicate titles

const expected = { links: [], tasks: [], secrets: [], notes: 0, attachments: [], texts: [] };
// Each note carries a token, so a checker can tell which note a link lands on, whatever the file is called.
const token = (id) => `<div>token-${id}</div>`;
const link = (from, text, target, html) => {
  expected.links.push({ from, text, target });
  return html;
};

const work = [
  { title: "Plan", body: token("work-plan") },
  {
    title: "Kickoff",
    body:
      token("work-kickoff") +
      `<div>${link("work-kickoff", "Plan", "work-plan", appLink("Plan", 1))}</div>` +
      `<div>${link("work-kickoff", "Budget", "money-budget", appLink("Budget", 2))}</div>` +
      `<div>${link("work-kickoff", "Roadmap draft", "work-roadmap", appLink("Roadmap draft", 3))}</div>` +
      `<div>${link("work-kickoff", "Meeting notes", "money-meetings", `<a href="https://share.evernote.com/note/${guid(4)}">Meeting notes</a>`)}</div>` +
      `<div>${link("work-kickoff", "Vendors", "money-vendors", `<a href="https://www.evernote.com/shard/s1/nl/123/${guid(5)}/">Vendors</a>`)}</div>` +
      `<div>${link("work-kickoff", "budget 2024 q1!", "money-q1", appLink("budget 2024 q1!", 6))}</div>` +
      `<div>${link("work-kickoff", "Not exported", null, appLink("Not exported", 7))}</div>`,
  },
  { title: "Roadmap 2025", body: token("work-roadmap") },
  {
    title: "Status",
    body:
      token("work-status") +
      `<div>${link("work-status", "Roadmap 2025", "work-roadmap", appLink("Roadmap 2025", 3))}</div>`,
  },
];
const money = [
  { title: "Budget", body: token("money-budget") },
  { title: "Meeting notes", body: token("money-meetings") },
  { title: "Vendors", body: token("money-vendors") },
  { title: "Budget 2024 Q1", body: token("money-q1") },
];
const garden = [
  { title: "Plan", body: token("home-plan") },
  { title: "Budget", body: token("home-budget") },
  {
    title: "Seeds",
    body: `${token("home-seeds")}<div>${link("home-seeds", "Plan", "home-plan", appLink("Plan", 8))}</div>`,
  },
];
put("stress/Work/Projects.enex", enex(work));
put("stress/Work/Money.enex", enex(money));
put("stress/Home/Garden.enex", enex(garden));
put("stress/Home/Diary.enex", enex([{ title: "Monday", body: "<div>first part of a split export</div>" }]));
put("stress/Home/Diary (1).enex", enex([{ title: "Tuesday", body: "<div>second part of a split export</div>" }]));
expected.notes += work.length + money.length + garden.length + 2;

// ---------- stress: tasks

// Ids are UUIDs, as in real exports.
const GROUP = "9c1f4e2a-0000-4000-8000-000000000001";
const task = (id, title, fields, reminders = "") =>
  `<task><title>${title}</title><created>20240101T000000Z</created><updated>20240101T000000Z</updated><taskStatus>${fields.status ?? "open"}</taskStatus><inNote>true</inNote><taskFlag>${fields.flag ?? "false"}</taskFlag><sortWeight>${id}</sortWeight><noteLevelID>9c1f4e2a-0000-4000-8000-0000000001${id.slice(1).padStart(2, "0")}</noteLevelID><taskGroupNoteLevelID>${GROUP}</taskGroupNoteLevelID>${fields.xml ?? ""}${reminders}</task>`;
const reminder = (date, option = "date_time") =>
  `<reminder><created>20240101T000000Z</created><updated>20240101T000000Z</updated><noteLevelID>r</noteLevelID><reminderDate>${date}</reminderDate><reminderDateUIOption>${option}</reminderDateUIOption><reminderStatus>active</reminderStatus></reminder>`;
const tasks = [
  [
    "t1",
    "Renew passport",
    {
      xml: "<dueDate>20240110T225959Z</dueDate><dueDateUIOption>date_only</dueDateUIOption><timeZone>Europe/Berlin</timeZone>",
    },
    "",
    { due: "2024-01-10" },
  ],
  [
    "t2",
    "Call the bank",
    {
      xml: "<dueDate>20240301T150000Z</dueDate><dueDateUIOption>date_time</dueDateUIOption><timeZone>America/New_York</timeZone>",
    },
    "",
    { due: "2024-03-01" },
  ],
  // Midnight in Tokyo is still the day before in UTC: the date must come from the task's time zone.
  [
    "t3",
    "Book flights",
    {
      xml: "<dueDate>20240110T150000Z</dueDate><dueDateUIOption>date_only</dueDateUIOption><timeZone>Asia/Tokyo</timeZone>",
    },
    "",
    { due: "2024-01-11" },
  ],
  ["t4", "Water plants", {}, reminder("20240109T070000Z"), { reminder: "2024-01-09" }],
  [
    "t5",
    "Team sync",
    {
      xml: "<dueDate>20240108T090000Z</dueDate><dueDateUIOption>date_time</dueDateUIOption><timeZone>UTC</timeZone><recurrence>DTSTART:20240108T090000Z\\nRRULE:FREQ=WEEKLY;BYDAY=MO,FR</recurrence><repeatAfterCompletion>false</repeatAfterCompletion>",
    },
    "",
    { due: "2024-01-08", repeats: true },
  ],
  [
    "t6",
    "Pay insurance",
    {
      xml: "<dueDate>20250102T055959Z</dueDate><dueDateUIOption>date_only</dueDateUIOption><timeZone>America/Chicago</timeZone><recurrence>DTSTART;TZID=America/Chicago:20250101T235959\\nRRULE:FREQ=YEARLY;INTERVAL=1</recurrence><repeatAfterCompletion>false</repeatAfterCompletion>",
    },
    "",
    { due: "2025-01-01", repeats: true },
  ],
  [
    "t7",
    "File taxes",
    { status: "completed", xml: "<statusUpdated>20240415T120000Z</statusUpdated>" },
    "",
    { done: true },
  ],
  ["t8", "Fix the roof", { flag: "true" }, "", { flagged: true }],
];
put(
  "stress/Tasks.enex",
  enex([
    {
      title: "Todo",
      // Exports put a short text inside the task block for apps that can't show tasks; this is a stand-in for it.
      body: `<div>Things to do</div><div style="--en-task-group:true; --en-id:${GROUP};"><div>Task list stand-in for older apps.</div></div>`,
      extra: tasks.map(([id, title, fields, rem]) => task(id, title, fields, rem)).join(""),
    },
  ]),
);
for (const [, title, , , want] of tasks) expected.tasks.push({ title, ...want });
expected.notes += 1;

// ---------- stress: encrypted text

function aes(html, password) {
  const salt = bytes("salt", 16);
  const hmacSalt = bytes("hmac", 16);
  const iv = bytes("iv", 16);
  const key = pbkdf2Sync(password, salt, 50_000, 16, "sha256");
  const c = createCipheriv("aes-128-cbc", key, iv);
  const body = Buffer.concat([Buffer.from("ENC0"), salt, hmacSalt, iv, c.update(html, "utf8"), c.final()]);
  const mac = createHmac("sha256", pbkdf2Sync(password, hmacSalt, 50_000, 16, "sha256"))
    .update(body)
    .digest();
  return Buffer.concat([body, mac]).toString("base64");
}
function rc2(text, password) {
  const b = Buffer.from(text, "utf8");
  const rest = Buffer.concat([b, Buffer.alloc((8 - ((b.length + 4) % 8)) % 8)]);
  const plain = Buffer.concat([Buffer.from(rc2Checks(rest)[0].padEnd(4, "0"), "latin1"), rest]);
  return Buffer.from(rc2EncryptEcb(rc2Keys(createHash("md5").update(password).digest(), 64), plain)).toString("base64");
}
put(
  "stress/Encrypted.enex",
  enex([
    {
      title: "Secrets",
      body: `<div>AES: <en-crypt hint="bench" cipher="AES" length="128">${aes("<div>aessecret4711</div>", PASSWORD)}</en-crypt></div><div>RC2: <en-crypt hint="bench" cipher="RC2" length="64">${rc2("rctwosecret0815", PASSWORD)}</en-crypt></div>`,
    },
  ]),
);
expected.secrets.push({ cipher: "AES", text: "aessecret4711" }, { cipher: "RC2", text: "rctwosecret0815" });
expected.notes += 1;

// ---------- stress: names and attachments

const named = (title, extra = {}) => ({ title, body: `<div>${esc(title)} body</div>`, ...extra });
const imgA = bytes("image-a", 2048);
const imgB = bytes("image-b", 2048);
const clip = bytes("clip", 1024);
const names = [
  named("CON"),
  named("nul.txt"),
  named('a:b*c?"d<e>|f'),
  named("trailing dot."),
  named("Ünïcödé ✓ 日本語 עברית"),
  named("emoji 🎉 note"),
  named(`${"Very long title ".repeat(14)}end`),
  named("Same"),
  named("same"),
  named("SAME"),
  named("#hash ^caret [bracket]"),
  // Two notes with an attachment of the same name and different bytes: both must survive.
  {
    title: "Photo one",
    body: `<div><en-media hash="${md5(imgA)}" type="image/png"/></div>`,
    resources: [{ data: imgA, mime: "image/png", fileName: "image.png" }],
  },
  {
    title: "Photo two",
    body: `<div><en-media hash="${md5(imgB)}" type="image/png"/></div>`,
    resources: [{ data: imgB, mime: "image/png", fileName: "image.png" }],
  },
  // A web clipper file name that is a URL path with a query.
  {
    title: "Clipped image",
    body: `<div><en-media hash="${md5(clip)}" type="image/png"/></div>`,
    resources: [{ data: clip, mime: "image/png", fileName: "/23e4a5a4.png?width=120&height=80" }],
  },
];
put("stress/Names.enex", enex(names));
expected.notes += names.length;
expected.attachments.push(md5(imgA), md5(imgB), md5(clip));

// ---------- stress: rich content (every word must survive)

const rich = [
  {
    title: "Formatting",
    body:
      "<h1>Heading alpha</h1><h2>Heading bravo</h2><div><b>bold charlie</b> <i>italic delta</i> <u>underline echo</u> <s>strike foxtrot</s> <sup>sup golf</sup> <sub>sub hotel</sub></div>" +
      '<div><span style="color:#ff0000">red india</span> <span style="--en-highlight:yellow">highlight juliet</span> <font face="Courier">font kilo</font></div>' +
      "<blockquote><div>quote lima</div></blockquote><hr/><div>entities &amp; mike &lt;november&gt; &quot;oscar&quot; &#169; papa&nbsp;quebec</div>",
  },
  {
    title: "Lists",
    body:
      "<ul><li>bullet romeo<ul><li>nested sierra<ol><li>deep tango</li></ol></li></ul></li><li>bullet uniform</li></ul>" +
      '<ol start="3"><li>ordered victor</li><li><div><en-todo checked="true"/>checked whiskey</div></li><li><div><en-todo/>open xray</div></li></ol>' +
      '<div><en-todo checked="false"/>loose yankee</div><div><en-todo checked="true"/>loose zulu</div>',
  },
  {
    title: "Tables",
    body:
      "<table><tr><th>head amber</th><th>head beige</th></tr><tr><td>cell coral<br/>second line denim</td><td><ul><li>listed ebony</li><li>listed fawn</li></ul></td></tr></table>" +
      '<table><tr><td colspan="2">merged garnet</td></tr><tr><td>cell hazel</td><td>cell ivory</td></tr></table>' +
      "<table><tr><td><table><tr><td>inner jade</td></tr></table></td><td>outer khaki</td></tr></table>",
  },
  {
    title: "Code",
    body:
      '<div style="--en-codeblock:true; --en-syntaxLanguage:python;"><div>def lemon(): return "lime"</div><div>    indented mango</div></div>' +
      "<pre>pre nectar\n  pre olive</pre><div><code>inline peach</code></div>",
  },
];
put("stress/Content.enex", enex(rich));
expected.notes += rich.length;

// ---------- stress: encodings

const mixed = Buffer.from(enex([{ title: "Mixed bytes", body: "<div>MARK and cafe</div>" }]), "utf8");
const at = mixed.indexOf("MARK");
// Windows-1252 curly quotes around "quoted", and an e-acute: not valid UTF-8.
put(
  "stress/Mixed encoding.enex",
  Buffer.concat([
    mixed.subarray(0, at),
    Buffer.from([0x93]),
    Buffer.from("quoted"),
    Buffer.from([0x94, 0x20, 0xe9]),
    mixed.subarray(at + 4),
  ]),
);
expected.texts.push({ note: "Mixed bytes", text: "“quoted” é and cafe" });
put(
  "stress/Utf16.enex",
  Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(enex([{ title: "Sixteen", body: "<div>utf sixteen grüße</div>" }]), "utf16le"),
  ]),
);
expected.texts.push({ note: "Sixteen", text: "utf sixteen grüße" });
expected.notes += 2;

writeFileSync(join(root, "stress-expected.json"), `${JSON.stringify(expected, null, 2)}\n`);

// ---------- big and huge

async function streamed(rel, count, size, seed) {
  const path = join(root, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  const out = createWriteStream(path);
  const write = (s) => (out.write(s) ? Promise.resolve() : new Promise((r) => out.once("drain", r)));
  await write(HEAD);
  for (let i = 0; i < count; i++) {
    const data = bytes(`${seed}-${i}`, size);
    const hash = md5(data);
    await write(
      `<note><title>${seed} note ${i + 1}</title><created>20240102T030405Z</created><updated>20240103T030405Z</updated><content><![CDATA[<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd"><en-note><div>Body of ${seed} note ${i + 1}.</div><en-media hash="${hash}" type="application/octet-stream"/></en-note>]]></content><resource><data encoding="base64">`,
    );
    // Base64 in 76-character lines, as exports write it, in pieces so no attachment is held as one string.
    const chunk = 57 * 4096;
    for (let o = 0; o < data.length; o += chunk)
      await write(
        `${data
          .subarray(o, o + chunk)
          .toString("base64")
          .replace(/.{76}/g, "$&\n")}\n`,
      );
    await write(
      `</data><mime>application/octet-stream</mime><resource-attributes><file-name>blob-${i + 1}.bin</file-name></resource-attributes></resource></note>\n`,
    );
  }
  await write(FOOT);
  await new Promise((r) => out.end(r));
}

if (values.big) await streamed("big/Attachments.enex", 3, 200 * 1024 * 1024, "big");
if (values.huge) await streamed("huge/Archive.enex", 1500, 1200 * 1024, "huge");
console.log(`Wrote the inputs to ${root}`);
