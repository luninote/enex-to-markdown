import { createHash, randomBytes } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { YARLE as FIXTURES, HAS_YARLE } from "../testing.ts";
import { type EnexNote, type ReadEnexOptions, readEnex } from "./index.ts";

/** Feeds the bytes in small pieces, so every boundary (tags, base64, multi-byte characters) gets split. */
function chunked(data: Buffer | string, size: number): Readable {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const parts: Buffer[] = [];
  for (let i = 0; i < buf.length; i += size) parts.push(buf.subarray(i, i + size));
  return Readable.from(parts);
}

async function readAll(input: Readable, opts: ReadEnexOptions = {}) {
  const reader = readEnex(input, opts);
  const notes: EnexNote[] = [];
  for await (const n of reader.notes) notes.push(n);
  return { notes, info: reader.info };
}

class Collect extends Writable {
  chunks: Buffer[] = [];
  override _write(chunk: Buffer, _enc: BufferEncoding, cb: () => void) {
    this.chunks.push(chunk);
    cb();
  }
  get bytes() {
    return Buffer.concat(this.chunks);
  }
}

const md5 = (b: Buffer) => createHash("md5").update(b).digest("hex");
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

function enex(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE en-export SYSTEM "http://xml.evernote.com/pub/evernote-export3.dtd">\n<en-export export-date="20200101T000000Z" application="Evernote" version="10.1">${inner}</en-export>`;
}

function noteXml(title: string, extra = "", content = "<div>hello</div>"): string {
  return `<note><title>${title}</title><content><![CDATA[<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd"><en-note>${content}</en-note>]]></content><created>20200102T030405Z</created><updated>20200103T030405Z</updated>${extra}</note>`;
}

describe("readEnex", () => {
  it("yields notes one at a time with the same result however the input is split", async () => {
    const data = randomBytes(200_000);
    const xml = enex(
      noteXml(
        "Ünïcødé 日本語 🎉",
        `<tag>a</tag><tag>b</tag><resource><data encoding="base64">${data.toString("base64").replace(/(.{76})/g, "$1\n")}</data><mime>image/png</mime><width>10</width><height>20</height></resource>`,
      ) + noteXml("second"),
    );
    const whole = await readAll(chunked(xml, 1 << 20));
    for (const size of [1, 7, 4093]) {
      const split = await readAll(chunked(xml, size));
      expect(split.notes.map((n) => [n.title, n.content, n.tags, n.resources[0]?.digest])).toEqual(
        whole.notes.map((n) => [n.title, n.content, n.tags, n.resources[0]?.digest]),
      );
    }
    expect(whole.notes).toHaveLength(2);
    expect(whole.notes[0]?.title).toBe("Ünïcødé 日本語 🎉");
    expect(whole.notes[0]?.resources[0]).toMatchObject({
      hasData: true,
      digest: { md5: md5(data), sha256: sha256(data), size: data.length },
      mime: "image/png",
      width: 10,
      height: 20,
    });
    expect(whole.info).toMatchObject({ application: "Evernote", version: "10.1", notesSeen: 2, truncated: null });
  });

  it("streams resource bytes into the sink in pieces, never as one buffer", async () => {
    const data = randomBytes(3_000_000);
    const xml = enex(
      noteXml(
        "big",
        `<resource><data encoding="base64">${data.toString("base64")}</data><mime>application/pdf</mime></resource>`,
      ),
    );
    const sinks: Collect[] = [];
    const { notes } = await readAll(chunked(xml, 65_536), {
      sink: () => {
        const s = new Collect();
        sinks.push(s);
        return s;
      },
    });
    expect(sinks).toHaveLength(1);
    const sink = sinks[0] as Collect;
    expect(sink.bytes.equals(data)).toBe(true);
    expect(sink.chunks.length).toBeGreaterThan(10);
    expect(Math.max(...sink.chunks.map((c) => c.length))).toBeLessThan(200_000);
    expect(notes[0]?.resources[0]?.sink).toBe(sink);
  });

  it("never throws on missing or invalid dates, and reports them", async () => {
    const xml = enex(
      "<note><title>no dates</title><content>&lt;en-note/&gt;</content></note>" +
        "<note><title>bad</title><content/><created>20231399T000000Z</created><updated>2024-05-06T07:08:09+02:00</updated></note>",
    );
    const { notes } = await readAll(chunked(xml, 100));
    expect(notes[0]?.created).toBeNull();
    expect(notes[0]?.warnings.find((w) => w.code === "missing_date")?.count).toBe(2);
    expect(notes[1]?.created).toBeNull();
    expect(notes[1]?.updated?.toISOString()).toBe("2024-05-06T05:08:09.000Z");
    expect(notes[1]?.warnings.find((w) => w.code === "invalid_date")?.details).toEqual(["created: 20231399T000000Z"]);
  });

  it("reads every note attribute, application data, tasks with reminders, and GUIDs", async () => {
    const xml = enex(
      noteXml(
        "full",
        `<note-attributes><author>me</author><latitude>1.5</latitude><source-url>  https://x.test/  </source-url><reminder-time>20250101T000000Z</reminder-time><application-data key="k">v</application-data></note-attributes>
         <task><title>Pay</title><noteLevelID> t-1 </noteLevelID><taskStatus>completed</taskStatus><taskFlag>true</taskFlag><sortWeight>B</sortWeight><taskGroupNoteLevelID>g1</taskGroupNoteLevelID><dueDate>20250102T000000Z</dueDate><timeZone>Europe/Paris</timeZone><reminder><reminderDate>20250101T090000Z</reminderDate><reminderStatus>active</reminderStatus></reminder></task>
         <guid>0d5e7f40-0000-4000-8000-000000000001</guid>`,
      ) +
        noteXml(
          "meta",
          "<note-custom-metadata><guid>0d5e7f40-0000-4000-8000-000000000002</guid><notebook-name>NB</notebook-name></note-custom-metadata>",
        ),
    );
    const { notes } = await readAll(chunked(xml, 64));
    const [full, meta] = notes as [EnexNote, EnexNote];
    expect(full.attributes).toMatchObject({
      author: "me",
      latitude: "1.5",
      "source-url": "https://x.test/",
      "reminder-time": "20250101T000000Z",
    });
    expect(full.applicationData).toEqual({ k: "v" });
    expect(full.guid).toBe("0d5e7f40-0000-4000-8000-000000000001");
    expect(full.tasks).toHaveLength(1);
    expect(full.tasks[0]).toMatchObject({
      id: "t-1",
      title: "Pay",
      status: "completed",
      flag: true,
      sortWeight: "B",
      groupId: "g1",
    });
    expect(full.tasks[0]?.dueDate?.toISOString()).toBe("2025-01-02T00:00:00.000Z");
    expect(full.tasks[0]?.fields.timeZone).toBe("Europe/Paris");
    expect(full.tasks[0]?.reminders).toEqual([{ reminderDate: "20250101T090000Z", reminderStatus: "active" }]);
    expect(meta.guid).toBe("0d5e7f40-0000-4000-8000-000000000002");
    expect(meta.customMetadata["notebook-name"]).toBe("NB");
  });

  it("parses recognition data, alternate data, and resources without data", async () => {
    const reco = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE recoIndex PUBLIC "SYSTEM" "http://xml.evernote.com/pub/recoIndex.dtd"><recoIndex docType="printed" objType="image" lang="en"><item x="200" y="10" w="50" h="20"><t w="30">world</t><t w="80">World</t></item><item x="10" y="12" w="50" h="20"><t w="90">Hello</t></item><item x="10" y="60" w="50" h="20"><t w="70">line2</t></item></recoIndex>`;
    const alt = Buffer.from("alternate bytes");
    const xml = enex(
      noteXml(
        "reco",
        `<resource><data encoding="base64">${Buffer.from("img").toString("base64")}</data><mime>image/jpeg</mime><recognition><![CDATA[${reco}]]></recognition><alternate-data encoding="base64">${alt.toString("base64")}</alternate-data><resource-attributes><file-name>a.jpg</file-name><camera-make>X</camera-make></resource-attributes></resource><resource><mime>application/pdf</mime></resource>`,
      ),
    );
    const { notes } = await readAll(chunked(xml, 33));
    const [r0, r1] = notes[0]?.resources ?? [];
    expect(r0?.recognition).toMatchObject({ text: "Hello World\nline2", items: 3, docType: "printed", lang: "en" });
    expect(r0?.alternate).toEqual({ md5: md5(alt), sha256: sha256(alt), size: alt.length });
    expect(r0?.attributes).toEqual({ "file-name": "a.jpg", "camera-make": "X" });
    expect(r1).toMatchObject({ hasData: false, digest: { size: 0 } });
    expect(notes[0]?.warnings.map((w) => w.code)).toContain("resource_without_data");
  });

  it("reports byte offsets that let a later read resume at the next note", async () => {
    const xml = enex([1, 2, 3, 4].map((i) => noteXml(`n${i} — ✓`)).join("\n"));
    const buf = Buffer.from(xml);
    const { notes } = await readAll(chunked(buf, 50));
    const offset = notes[1]?.byteEnd as number;
    expect(buf.subarray(offset - 7, offset).toString()).toBe("</note>");
    const rest = await readAll(chunked(buf.subarray(offset), 50), { startOffset: offset, firstOrdinal: 2 });
    expect(rest.notes.map((n) => [n.ordinal, n.title])).toEqual([
      [2, "n3 — ✓"],
      [3, "n4 — ✓"],
    ]);
    expect(rest.notes[1]?.byteEnd).toBe(notes[3]?.byteEnd);
  });

  it("skips earlier notes without writing their resources when resuming by ordinal", async () => {
    const res = `<resource><data encoding="base64">${Buffer.from("x").toString("base64")}</data></resource>`;
    const xml = enex([0, 1, 2].map((i) => noteXml(`n${i}`, res)).join(""));
    let sinks = 0;
    const { notes, info } = await readAll(chunked(xml, 20), {
      skipBefore: 2,
      sink: () => {
        sinks++;
        return new Collect();
      },
    });
    expect(notes.map((n) => n.ordinal)).toEqual([2]);
    expect(sinks).toBe(1);
    expect(info.notesSeen).toBe(3);
  });

  it.skipIf(!HAS_YARLE)("recovers a note whose note-attributes were never closed (Yarle test.enex)", async () => {
    const file = join(FIXTURES, "test.enex");
    const { notes } = await readAll(createReadStream(file));
    expect(notes).toHaveLength(1);
    expect(notes[0]?.content).toContain("Draft the proposal");
    expect(notes[0]?.attributes.author).toBe(/<author>([^<]+)<\/author>/.exec(readFileSync(file, "utf8"))?.[1]);
    expect(notes[0]?.warnings.find((w) => w.code === "xml_error")).toBeTruthy();
  });

  it("flags cut-off files, password-protected exports, NUL characters and damaged base64", async () => {
    const xml = enex(
      noteXml("nul", "", "<div>a\u0000b</div>") +
        `<note><title>locked</title><content encoding="base64:aes">QUJD</content></note>` +
        noteXml("bad64", `<resource><data encoding="base64">QUJD*RA==</data></resource>`) +
        "<note><title>cut</title><content><![CDATA[<en-note>hal",
    );
    const { notes, info } = await readAll(chunked(xml, 16));
    expect(notes.map((n) => n.title)).toEqual(["nul", "locked", "bad64"]);
    expect(notes[0]?.content).toContain("<div>ab</div>");
    expect(notes[0]?.warnings.map((w) => w.code)).toContain("control_chars_removed");
    expect(notes[1]?.encryptedExport).toBe(true);
    expect(notes[2]?.warnings.map((w) => w.code)).toContain("bad_base64");
    expect(notes[2]?.resources[0]?.digest.size).toBe(4);
    expect(info.truncated).toEqual({ ordinal: 3, title: "cut" });
    expect(info.notesSeen).toBe(4);
    expect(info.cutOff).toBe(true);
    expect(info.warnings.map((w) => w.code)).toContain("file_cut_off");
  });

  it("flags a file cut off between two notes, where no half note shows it", async () => {
    const whole = enex(noteXml("one") + noteXml("two"));
    const cut = whole.slice(0, whole.indexOf("</note>") + "</note>".length);
    const { notes, info } = await readAll(chunked(cut, 16));
    expect(notes.map((n) => n.title)).toEqual(["one"]);
    expect(info.truncated).toBeNull();
    expect(info.cutOff).toBe(true);
    expect(info.warnings.map((w) => w.code)).toContain("file_cut_off");
    const ok = await readAll(chunked(whole, 16));
    expect(ok.info.cutOff).toBe(false);
    expect(ok.info.warnings.map((w) => w.code)).not.toContain("file_cut_off");
  });

  it.skipIf(!HAS_YARLE)("index mode reads titles and GUIDs only and never opens a sink", async () => {
    const { notes } = await readAll(createReadStream(join(FIXTURES, "withPicture.enex")), {
      index: true,
      sink: () => {
        throw new Error("no sink in index mode");
      },
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]?.title).toBe("test - note with picture");
    expect(notes[0]?.content).toBe("");
    expect(notes[0]?.resources).toEqual([]);
  });
});
