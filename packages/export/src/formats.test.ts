import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { readEnex } from "@luninote/enml/reader";
import { describe, expect, it } from "vitest";
import type { DocNode } from "./doc.ts";
import { base64Lines, ENEX_FOOTER, enexHeader, enexNote } from "./enex.ts";
import { docToEnml } from "./enml.ts";
import { docToHtml } from "./html.ts";
import { docToMarkdown } from "./markdown.ts";
import { attachmentPath, hrefOf, relativePath, safeName, UniqueNames } from "./names.ts";
import type { RenderContext } from "./render.ts";

const t = (text: string, marks?: DocNode["marks"]): DocNode =>
  marks ? { type: "text", text, marks } : { type: "text", text };
const p = (...content: DocNode[]): DocNode => ({ type: "paragraph", content });
const doc = (...content: DocNode[]): DocNode => ({ type: "doc", content });
const link = (href: string) => ({ type: "link", attrs: { href } });

const NOTE = "0199d3a0-0000-7000-8000-00000000aaaa";
const RES = "0199d3a0-0000-7000-8000-00000000bbbb";
const ctx: RenderContext = {
  attachment: (id) =>
    id === RES ? { href: "../../attachments/abc.png", mime: "image/png", filename: "map.png" } : null,
  noteLink: (id) => (id === NOTE ? "Other%20note.html" : null),
};

describe("file names", () => {
  it("are safe on Windows, short, and unique per folder ignoring case", () => {
    expect(safeName('a<b>:c"d/e\\f|g?h*i')).toBe("a_b__c_d_e_f_g_h_i");
    expect(safeName("CON")).toBe("_CON");
    expect(safeName("nul.txt")).toBe("_nul.txt");
    expect(safeName("  trailing dots... ")).toBe("trailing dots");
    expect(safeName("")).toBe("Untitled");
    expect(safeName("x\u0001y")).toBe("x_y");
    expect(safeName("é".repeat(200)).length).toBeLessThanOrEqual(90);
    const u = new UniqueNames();
    expect([u.take("Note", ".md"), u.take("note", ".md"), u.take("NOTE", ".md"), u.take("Other", ".md")]).toEqual([
      "Note.md",
      "note (2).md",
      "NOTE (3).md",
      "Other.md",
    ]);
  });

  it("relative paths and hrefs", () => {
    expect(relativePath("html/Work/A.html", "attachments/x.png")).toBe("../../attachments/x.png");
    expect(relativePath("html/Work/A.html", "html/Work/B.html")).toBe("B.html");
    expect(relativePath("trash/html/Work/A.html", "html/Home/B.html")).toBe("../../../html/Home/B.html");
    expect(hrefOf("../My notes (1)/a#b.html")).toBe("../My%20notes%20%281%29/a%23b.html");
    expect(attachmentPath("ff", "image/JPEG")).toBe("attachments/ff.jpg");
    expect(attachmentPath("ff", null)).toBe("attachments/ff.bin");
  });
});

describe("Markdown", () => {
  it("writes GFM for what it can and HTML for what it can't", () => {
    const md = docToMarkdown(
      doc(
        { type: "heading", attrs: { level: 2 }, content: [t("Plan")] },
        p(
          t("bold", [{ type: "bold" }]),
          t(" and "),
          t("under", [{ type: "underline" }]),
          t(" "),
          t("see", [link(`/note/${NOTE}`)]),
        ),
        p(t("1. not a list * star _ under [x]")),
        {
          type: "taskList",
          content: [
            { type: "taskItem", attrs: { checked: true }, content: [p(t("done"))] },
            { type: "taskItem", attrs: { checked: false }, content: [p(t("todo"))] },
          ],
        },
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                { type: "tableHeader", content: [p(t("A|B"))] },
                { type: "tableHeader", content: [p(t("C"))] },
              ],
            },
            {
              type: "tableRow",
              content: [
                { type: "tableCell", content: [p(t("1"))] },
                { type: "tableCell", content: [p(t("2"))] },
              ],
            },
          ],
        },
        p({ type: "attachment", attrs: { resourceId: RES, filename: "map.png", display: "inline" } }),
        { type: "codeBlock", attrs: { language: "js" }, content: [t("a ``` b")] },
        p(
          t("gone", [link("javascript:alert(1)")]),
          t(" "),
          t("x", [{ type: "highlight", attrs: { color: "#fbe3a1" } }]),
        ),
      ),
      ctx,
    );
    expect(md).toContain("## Plan");
    expect(md).toContain("**bold** and <u>under</u> [see](<Other%20note.html>)");
    expect(md).toContain("1\\. not a list \\* star \\_ under \\[x\\]");
    expect(md).toContain("- [x] done\n- [ ] todo");
    expect(md).toContain("| A\\|B | C |\n| --- | --- |\n| 1 | 2 |");
    expect(md).toContain("![map.png](<../../attachments/abc.png>)");
    expect(md).toContain("````js\na ``` b\n````");
    expect(md).toContain('gone <mark style="background-color:#fbe3a1">x</mark>');
    expect(md).not.toContain("javascript:");
  });

  it("indents what's inside a task item to the item's text, not past its checkbox (that would be a code block)", () => {
    const md = docToMarkdown(
      doc({
        type: "taskList",
        content: [
          {
            type: "taskItem",
            attrs: { checked: false },
            content: [
              p(t("Pack")),
              {
                type: "taskList",
                content: [{ type: "taskItem", attrs: { checked: true }, content: [p(t("Chargers"))] }],
              },
            ],
          },
        ],
      }),
      ctx,
    );
    expect(md).toBe("- [ ] Pack\n  - [x] Chargers\n");
  });

  it("keeps emphasis delimiters off whitespace", () => {
    expect(docToMarkdown(doc(p(t("a"), t(" b ", [{ type: "bold" }]), t("c"))), ctx)).toBe("a **b** c\n");
  });
});

describe("HTML", () => {
  it("links attachments and notes relatively and never renders kept raw markup", () => {
    const html = docToHtml(
      doc(
        p(
          t("see", [link(`/note/${NOTE}`)]),
          t(" "),
          t("missing", [link("/note/0199d3a0-0000-7000-8000-00000000cccc")]),
        ),
        p({ type: "attachment", attrs: { resourceId: RES, filename: "map.png", display: "inline" } }),
        p({ type: "unsupported", attrs: { raw: '<svg onload="alert(1)"><text>kept</text></svg>' } }),
        {
          type: "webClip",
          attrs: { html: `<p>clip <img data-resource-id="${RES}" alt="x"> <a href="/note/${NOTE}">n</a></p>` },
        },
      ),
      ctx,
    );
    expect(html).toContain('<a href="Other%20note.html">see</a> missing');
    expect(html).toContain('<img src="../../attachments/abc.png" alt="map.png">');
    expect(html).toContain('<span class="unsupported">kept</span>');
    expect(html).not.toContain("onload");
    expect(html).toContain("src=&quot;../../attachments/abc.png&quot;");
    expect(html).toContain("href=&quot;Other%20note.html&quot;");
  });

  it("writes only numbers into a table cell's width, whatever the stored document holds", () => {
    const cell = (colwidth: unknown) =>
      docToHtml(
        doc({
          type: "table",
          content: [{ type: "tableRow", content: [{ type: "tableCell", attrs: { colwidth }, content: [p(t("c"))] }] }],
        }),
        ctx,
      );
    expect(cell([120, 80.4])).toContain('<td style="width:200px">');
    for (const bad of [['1px;background:url(https://x.test/a)"><img src=x onerror=alert(1)>'], [Infinity], [1e9], "12"])
      expect(cell(bad)).toContain("<td><p>c</p></td>");
  });

  it("with clipFileLinks off, only clip pictures reach a file; allowUrl judges every URL attribute in a clip", () => {
    const html = docToHtml(
      doc({
        type: "webClip",
        attrs: {
          html: `<img data-resource-id="${RES}" alt="pic"><a data-resource-id="${RES}">file</a><video poster="https://bad.test/p" src="https://ok.test/v"></video><img srcset="https://ok.test/1x 1x, https://bad.test/2x 2x">`,
        },
      }),
      { ...ctx, noteLink: () => null, clipFileLinks: false, allowUrl: (u) => !u.includes("bad.test") },
    );
    expect(html.match(/attachments\/abc\.png/g)).toHaveLength(1);
    expect(html).toContain("&lt;a&gt;file&lt;/a&gt;");
    expect(html).toContain("src=&quot;https://ok.test/v&quot;");
    expect(html).not.toContain("bad.test");
  });
});

describe("ENEX writer", () => {
  it("base64 in 76-character lines, whatever the chunk boundaries", async () => {
    const bytes = randomBytes(10_000);
    for (const size of [1, 7, 57, 100, 4096]) {
      const chunks = async function* () {
        for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
      };
      let out = "";
      for await (const s of base64Lines(chunks())) out += s;
      expect(out.split("\n").every((l) => l.length <= 76)).toBe(true);
      expect(Buffer.from(out.replace(/\n/g, ""), "base64").equals(bytes)).toBe(true);
    }
  });

  it("writes notes our reader reads back without warnings, bytes and hashes intact", async () => {
    const bytes = randomBytes(3000);
    const md5 = createHash("md5").update(bytes).digest("hex");
    const body = docToEnml(
      doc(p(t("Hello ]]> & <world>")), p({ type: "attachment", attrs: { resourceId: RES, mime: "image/png" } })),
      { resource: () => ({ md5, mime: "image/png" }) },
    );
    let xml = enexHeader(new Date("2026-10-12T10:00:00Z"));
    for await (const piece of enexNote({
      title: "A <title> & more",
      enml: body.enml,
      created: "2020-01-02T03:04:05.000Z",
      updated: "2021-01-02T03:04:05.000Z",
      tags: ["one", "two & three"],
      guid: NOTE,
      attributes: [
        ["author", "someone"],
        ["source-url", "https://example.org/?a=1&b=2"],
      ],
      resources: [
        {
          data: async function* () {
            yield bytes.subarray(0, 1000);
            yield bytes.subarray(1000);
          },
          mime: "image/png",
          width: 10,
          height: 20,
          attributes: [["file-name", "map.png"]],
        },
      ],
      tasks: [
        {
          fields: [
            ["title", "Task"],
            ["taskStatus", "open"],
            ["noteLevelID", "t1"],
          ],
        },
      ],
    }))
      xml += piece;
    xml += ENEX_FOOTER;
    const reader = readEnex(Readable.from([Buffer.from(xml)]));
    const notes = [];
    for await (const n of reader.notes) notes.push(n);
    expect(reader.info.warnings).toEqual([]);
    const [n] = notes;
    expect(n?.warnings).toEqual([]);
    expect(n?.title).toBe("A <title> & more");
    expect(n?.guid).toBe(NOTE);
    expect(n?.content).toBe(body.enml);
    expect(n?.tags).toEqual(["one", "two & three"]);
    expect(n?.created?.toISOString()).toBe("2020-01-02T03:04:05.000Z");
    expect(n?.attributes).toEqual({ author: "someone", "source-url": "https://example.org/?a=1&b=2" });
    expect(n?.resources[0]?.digest.md5).toBe(md5);
    expect(n?.resources[0]?.attributes["file-name"]).toBe("map.png");
    expect(n?.tasks[0]?.title).toBe("Task");
  });
});
